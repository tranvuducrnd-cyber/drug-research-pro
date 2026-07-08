/* ─────────────────────────────────────────────────────────────────────────
   Drug Research Pro – Frontend Application Logic
   ───────────────────────────────────────────────────────────────────────── */

'use strict';

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  drugName: '',
  dosageForm: '',
  openaiKey: '',
  serperKey: '',
  pubchemData: null,
  aiAnalysis: null,
  stabilityData: null,
  sraData: null,
  patentData: null,
};

// ── UI Helpers ────────────────────────────────────────────────────────────────

function toggleKeyVisibility(inputId, btn) {
  const el = document.getElementById(inputId);
  if (el.type === 'password') { el.type = 'text'; btn.textContent = '🙈'; }
  else { el.type = 'password'; btn.textContent = '👁'; }
}

function switchTab(tabId, btn) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  btn.classList.add('active');
}

function toggleSection(header) {
  const body = header.nextElementSibling;
  const btn = header.querySelector('.collapse-btn');
  if (!body) return;
  const collapsed = body.classList.toggle('collapsed');
  if (btn) btn.textContent = collapsed ? '▶' : '▼';
}

function html(strings, ...values) {
  return strings.reduce((acc, str, i) => acc + str + (values[i] !== undefined ? escHtml(values[i]) : ''), '');
}

function escHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Tự động biến URL trong chuỗi thành link clickable
function linkify(text) {
  if (!text) return '';
  const safe = escHtml(text);
  return safe.replace(
    /(https?:\/\/[^\s<&"']+)/g,
    '<a href="$1" target="_blank" rel="noopener" style="color:#818cf8;text-decoration:underline;word-break:break-all">$1</a>'
  );
}

// Render nguồn trích dẫn thành dạng có thể click
function renderRef(ref) {
  if (!ref) return '';
  // Tách DOI nếu có dạng doi.org/... hoặc 10.xxxx/...
  const withDoi = escHtml(ref).replace(
    /(10\.\d{4,}[^\/\s]*)(\/[^\s<&"']+)?/g,
    (match) => `<a href="https://doi.org/${match}" target="_blank" rel="noopener" style="color:#818cf8;text-decoration:underline">${match}</a>`
  );
  // Sau đó linkify URL thường
  return withDoi.replace(
    /(https?:\/\/[^\s<&"']+)/g,
    '<a href="$1" target="_blank" rel="noopener" style="color:#818cf8;text-decoration:underline;word-break:break-all">$1</a>'
  );
}

function setInner(id, content) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = content;
}

function show(id) { const el = document.getElementById(id); if (el) el.style.display = ''; }
function hide(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

// ── Progress Steps ────────────────────────────────────────────────────────────

const STEPS = [
  { id: 'step-pubchem',     label: 'Tra cứu ChEMBL – cấu trúc & tính chất',          icon: '🔬' },
  { id: 'step-ai',          label: 'AI phân tích: polymorph, pKa, đặc điểm',          icon: '🤖' },
  { id: 'step-stability',   label: 'Phân hủy cưỡng bức (Forced Degradation)',         icon: '🔥' },
  { id: 'step-sra',         label: 'Tra cứu công thức web Nga (Vidal.ru)',            icon: '🇷🇺' },
  { id: 'step-patents',     label: 'Tìm kiếm patent Google Patents',                  icon: '📄' },
];

function renderProgressSteps() {
  const container = document.getElementById('progress-steps');
  container.innerHTML = STEPS.map((s) => `
    <div class="progress-step" id="${s.id}">
      <span class="step-icon">${s.icon}</span>
      <span>${s.label}</span>
    </div>
  `).join('');
}

function setStepStatus(id, status, extraText = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('active', 'done', 'error');
  el.classList.add(status);
  const label = el.querySelector('span:last-child');
  const base = STEPS.find((s) => s.id === id)?.label || '';
  if (label) label.textContent = base + (extraText ? ' — ' + extraText : '');

  // Replace spinner if present
  const spin = el.querySelector('.spinner');
  if (spin) spin.remove();
  const icon = el.querySelector('.step-icon');
  if (status === 'active') {
    const sp = document.createElement('div');
    sp.className = 'spinner';
    icon.after(sp);
  } else if (status === 'done') {
    icon.textContent = '✅';
  } else if (status === 'error') {
    icon.textContent = '❌';
  }
}

// ── API Calls ─────────────────────────────────────────────────────────────────

async function api(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Main Search ───────────────────────────────────────────────────────────────

async function startSearch() {
  const drugName  = document.getElementById('drug-name').value.trim();
  const dosageForm = document.getElementById('dosage-form').value;
  const openaiKey = document.getElementById('openai-key').value.trim();
  const serperKey = document.getElementById('serper-key').value.trim();

  if (!drugName) { alert('Vui lòng nhập tên hoạt chất!'); return; }
  if (!dosageForm) { alert('Vui lòng chọn Dạng bào chế!'); return; }
  if (!openaiKey) { alert('Vui lòng nhập OpenAI API Key!'); return; }

  // Lưu API keys vào localStorage để không cần nhập lại
  localStorage.setItem('openai_api_key', openaiKey);
  localStorage.setItem('serper_api_key', serperKey);

  Object.assign(state, { drugName, dosageForm, openaiKey, serperKey });

  // Reset UI
  hide('empty-state');
  hide('results-section');
  show('loading-section');
  document.getElementById('loading-section').classList.add('active');
  document.getElementById('btn-search').disabled = true;

  renderProgressSteps();

  // Đặt trạng thái đang tải cho các tab chưa có dữ liệu
  const loadingHtml = (msg) => `<div class="empty-state" style="padding:2rem"><div class="empty-state-icon">⏳</div><div class="empty-state-sub">${msg}</div></div>`;
  setInner('sec-stability-sources', loadingHtml('Đang phân tích độ ổn định và lão hóa cấp tốc...'));
  setInner('sec-sra-products', loadingHtml('Đang tìm kiếm và dịch công thức từ Vidal.ru...'));
  setInner('sec-patents', loadingHtml('Đang phân tích patent (đợi Vidal hoàn thành)...'));

  try {
    // ── Step 1: ChEMBL Properties ────────────────────────────────────────
    setStepStatus('step-pubchem', 'active');
    try {
      state.pubchemData = await api('/api/properties', { drugName });
      setStepStatus('step-pubchem', 'done', state.pubchemData.chemblId || '');
    } catch (e) {
      setStepStatus('step-pubchem', 'error', e.message);
      state.pubchemData = null;
    }

    // ── Step 2: AI Analysis (polymorph + pKa + đặc điểm) ────────────────
    setStepStatus('step-ai', 'active');
    try {
      state.aiAnalysis = await api('/api/ai-analysis', {
        drugName, drugData: state.pubchemData, openaiKey, serperKey
      });
      setStepStatus('step-ai', 'done');
    } catch (e) {
      setStepStatus('step-ai', 'error', e.message);
      state.aiAnalysis = null;
    }

    // Render drug tab sớm để user đọc trong khi chờ
    renderDrugTab();
    hide('loading-section');
    show('results-section');

    // ── Step 3: Forced Degradation (luôn chạy, dùng AI nếu không có Serper)
    setStepStatus('step-stability', 'active');
    try {
      state.stabilityData = await api('/api/forced-degradation', { drugName, openaiKey, serperKey });
      const mode = state.stabilityData.mode === 'web-search' ? 'Web search' : 'AI knowledge';
      setStepStatus('step-stability', 'done', mode);
      renderStabilityTab();
    } catch (e) {
      setStepStatus('step-stability', 'error', e.message);
      renderStabilityError(e.message);
    }

    // ── Step 4: Vidal Formulas ────────────────────────────────────────────
    setStepStatus('step-sra', 'active');
    try {
      state.sraData = await api('/api/sra-formulas', { drugName, dosageForm, openaiKey });
      setStepStatus('step-sra', 'done', `${state.sraData.totalProducts || (state.sraData.products || []).length} sản phẩm`);
      renderSRATab();
    } catch (e) {
      setStepStatus('step-sra', 'error', e.message);
      renderSRAError(e.message);
    }

    // ── Step 5: Patents ─────────────────────────────────────────────────
    if (serperKey) {
      setStepStatus('step-patents', 'active');
      try {
        state.patentData = await api('/api/patents', { drugName, dosageForm, openaiKey, serperKey });
        setStepStatus('step-patents', 'done', `${(state.patentData.patents || []).length} patent`);
        renderPatentsTab();
      } catch (e) {
        setStepStatus('step-patents', 'error', e.message);
        renderPatentsError(e.message);
      }
    } else {
      setStepStatus('step-patents', 'error', 'Cần Serper.dev API key');
      renderPatentsError('Bạn cần cung cấp Serper.dev API key ở góc trên cùng và bấm nút "Tra cứu" lại để hệ thống bắt đầu tìm kiếm patent.');
    }

  } finally {
    document.getElementById('btn-search').disabled = false;
    document.getElementById('loading-section').classList.remove('active');
    hide('loading-section');
    show('results-section');
  }
}

// ── Render: Drug Tab ──────────────────────────────────────────────────────────

function renderDrugTab() {
  const pc = state.pubchemData;   // actually ChEMBL data now
  const ai = state.aiAnalysis;
  const p  = pc?.properties || {};
  const exp = pc?.experimental || {};

  // ── 1.1 Structure ───────────────────────────────────────────────────────────
  let structureHtml = '';

  if (pc) {
    const imgHtml = pc.imageUrl
      ? `<img class="structure-img" src="${pc.imageUrl}" alt="Cấu trúc ${escHtml(state.drugName)}" onerror="this.style.display='none'" />`
      : '<p style="color:var(--text-3);font-size:.8rem">Không có ảnh</p>';

    structureHtml = `
      <div class="structure-layout-simple" style="display: flex; gap: 1.5rem; align-items: flex-start;">
        <div class="structure-img-wrap" style="width: 220px; flex-shrink: 0; background: #fff; border-radius: var(--r-md); padding: 8px; display: flex; align-items: center; justify-content: center; aspect-ratio: 1;">
          ${imgHtml}
        </div>
        ${pc.synonyms?.length ? `
        <div style="flex-grow: 1;">
          <div class="data-item-label" style="font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3);font-weight:600;margin-bottom:8px">Tên đồng nghĩa (Synonyms)</div>
          <div class="tag-cloud" style="display: flex; flex-wrap: wrap; gap: 6px;">
            ${pc.synonyms.slice(0, 15).map((s) => `<span class="tag tag-cyan" style="font-size:.75rem;padding: 4px 10px;border-radius: 100px;background: rgba(34,211,238,0.1);border: 1px solid rgba(34,211,238,0.25);color: #67e8f9;font-weight: 500;">${escHtml(s)}</span>`).join('')}
          </div>
        </div>` : ''}
      </div>
      ${ai?.structure ? `
      <div class="insight-box mt-2">
        <div class="insight-label">🤖 AI Phân tích cấu trúc</div>
        <div>${escHtml(ai.structure.description || '')}</div>
        ${ai.structure.stereochemistry ? `<p class="mt-1 text-sm text-2"><strong>Lập thể:</strong> ${escHtml(ai.structure.stereochemistry)}</p>` : ''}
        ${ai.structure.functionalGroups?.length ? `
        <div class="mt-1 text-xs text-3">Nhóm chức:</div>
        <div class="tag-cloud">
          ${ai.structure.functionalGroups.map((g) => `<span class="tag tag-blue">${escHtml(g)}</span>`).join('')}
        </div>` : ''}
        ${ai.structure.pharmacophore ? `<div class="mt-1 text-sm text-2">${escHtml(ai.structure.pharmacophore)}</div>` : ''}
      </div>` : ''}
    `;
  } else {
    structureHtml = errorBox('Không tìm thấy dữ liệu. Kiểm tra lại tên hoạt chất (ưu tiên tên INN tiếng Anh).');
  }

  setInner('sec-structure', structureHtml);

  // ── Helpers: render field có nguồn ───────────────────────────────────────────
  // field có thể là string (cũ) hoặc {value, sourceUrl} (mới)
  function val(field) {
    if (!field) return '';
    return typeof field === 'object' ? (field.value || '') : String(field);
  }
  function srcBadge(field, label) {
    let url = typeof field === 'object' ? field.sourceUrl : null;
    if (!url) return label
      ? `<span class="tag" style="font-size:.6rem;padding:1px 6px;background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3)">🟡 AI – cần kiểm tra</span>`
      : '';
    if (url && !url.startsWith('http')) {
      if (url.startsWith('10.')) url = 'https://doi.org/' + url;
      else url = 'https://' + url;
    }
    return `<a href="${escHtml(url)}" target="_blank" rel="noopener"
      style="display:inline-flex;align-items:center;gap:3px;font-size:.62rem;padding:1px 6px;border-radius:4px;
      background:rgba(34,197,94,.12);color:#4ade80;border:1px solid rgba(34,197,94,.3);
      text-decoration:none;cursor:pointer" title="${escHtml(url)}">🟢 Xác minh →</a>`;
  }
  function row(label, field, extra) {
    const v = val(field);
    if (!v || v === 'Chưa có dữ liệu xác minh') return extra ? `<p class="mt-1 text-sm" style="color:var(--text-3)"><strong>${label}:</strong> Chưa có dữ liệu xác minh</p>` : '';
    return `<p class="mt-1 text-sm" style="line-height:1.7">
      <strong>${label}:</strong> ${linkify(v)} ${srcBadge(field, true)}
    </p>`;
  }

  // ── 1.2 Physical Properties ──────────────────────────────────────────────────
  let physHtml = '';

  // PubChem verified data (nếu có trong _pubchemRawData)
  const rawPc = ai?._pubchemRawData || {};
  const pcUrl = ai?._pubchemUrl || '';
  const pcVerifiedRows = [];
  const pcLabelMap = {
    meltingPoint: '🌡️ Nhiệt độ nóng chảy', boilingPoint: '⚗️ Nhiệt độ sôi',
    solubility: '💧 Độ tan', logP: 'LogP', density: '⚖️ Tỷ trọng',
    description: '🎨 Mô tả vật lý', color: '🎨 Màu sắc / Dạng',
    pka: 'pKa', opticalRotation: 'Quang hoạt', stability: 'Độ ổn định (shelf)',
  };
  for (const [key, items] of Object.entries(rawPc)) {
    if (!items?.length) continue;
    const label = pcLabelMap[key] || key;
    for (const item of items) {
      pcVerifiedRows.push(`<p class="mt-1 text-sm" style="line-height:1.7">
        <strong>${label}:</strong> ${escHtml(item.value)}
        <a href="${escHtml(item.sourceUrl)}" target="_blank" rel="noopener"
          style="display:inline-flex;align-items:center;gap:3px;font-size:.62rem;padding:1px 6px;border-radius:4px;
          background:rgba(34,197,94,.12);color:#4ade80;border:1px solid rgba(34,197,94,.3);
          text-decoration:none;margin-left:4px" title="PubChem">🟢 PubChem →</a>
      </p>`);
    }
  }

  if (pcVerifiedRows.length) {
    physHtml += `<div class="insight-box mt-2" style="border-color:rgba(34,197,94,.3);background:rgba(34,197,94,.05)">
      <div class="insight-label" style="color:#4ade80">✅ Dữ liệu xác minh từ PubChem CID ${escHtml(String(ai?._pubchemCid || ''))}</div>
      ${pcVerifiedRows.join('')}
    </div>`;
  }

  if (ai?.physical) {
    // Polymorph — card vàng riêng với link DOI
    const poly = ai.physical.polymorphs;
    if (poly && typeof poly === 'object' && poly.overview) {
      let srcUrl  = poly.sourceUrl || null;
      if (srcUrl && !srcUrl.startsWith('http')) {
        if (srcUrl.startsWith('10.')) srcUrl = 'https://doi.org/' + srcUrl;
        else srcUrl = 'https://' + srcUrl;
      }
      const paperTitle = poly.paperTitle || null;
      
      physHtml += `<div class="insight-box mt-2" style="border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.06)">
        <div class="insight-label" style="color:#fbbf24; margin-bottom:8px;">🔷 Dạng thù hình tinh thể (Polymorphism)</div>
        <p style="line-height:1.75; font-size:0.9rem;">${escHtml(poly.overview)}</p>`;
        
      if (poly.forms && Array.isArray(poly.forms)) {
        physHtml += `<div style="display:flex; flex-direction:column; gap:8px; margin-top:12px;">`;
        for (const f of poly.forms) {
          physHtml += `<div style="background:rgba(0,0,0,0.15); padding:8px 12px; border-radius:6px; border-left:3px solid #fbbf24;">
            <div style="font-weight:600; color:#fbbf24; margin-bottom:4px; font-size:0.9rem;">${escHtml(f.name)}</div>
            ${f.characteristics ? `<div style="font-size:0.85rem; margin-bottom:4px;"><span style="color:#a1a1aa;">Đặc điểm:</span> ${escHtml(f.characteristics)}</div>` : ''}
            ${f.differences ? `<div style="font-size:0.85rem;"><span style="color:#a1a1aa;">Khác biệt:</span> ${escHtml(f.differences)}</div>` : ''}
          </div>`;
        }
        physHtml += `</div>`;
      }
      
      if (poly.commercialForm) {
        physHtml += `<div class="mt-2" style="font-size:0.85rem; background:rgba(34,197,94,0.1); border:1px solid rgba(34,197,94,0.2); padding:8px; border-radius:6px; color:#4ade80;">
          <strong>✅ Dạng thương mại:</strong> ${escHtml(poly.commercialForm)}
        </div>`;
      }
      
      if (poly.morphology) {
        physHtml += `<div class="mt-2" style="font-size:0.85rem; background:rgba(251,191,36,0.1); border:1px solid rgba(251,191,36,0.2); padding:8px; border-radius:6px; color:#fcd34d;">
          <strong>🔬 Hình dạng tiểu phân:</strong> ${escHtml(poly.morphology)}
        </div>`;
      }
      
      if (poly.imageUrl) {
        physHtml += `<div class="mt-2" style="text-align:center;">
          <img src="${escHtml(poly.imageUrl)}" alt="Crystal morphology" style="max-width:100%; max-height:200px; border-radius:6px; border:1px solid rgba(255,255,255,0.1); object-fit:contain; background:#111; padding:4px;" onerror="this.style.display='none'">
        </div>`;
      }

      let paperInfo = '';
      if (paperTitle && srcUrl) {
         let doi = srcUrl;
         if (srcUrl.includes('doi.org/')) doi = srcUrl.split('doi.org/')[1];
         paperInfo = `📄 Nguồn: ${escHtml(paperTitle)} — DOI: ${escHtml(doi)}`;
      } else if (srcUrl) {
         paperInfo = `🔗 Nguồn: <a href="${escHtml(srcUrl)}" target="_blank" rel="noopener" style="color:#fbbf24">${escHtml(srcUrl)}</a>`;
      } else if (paperTitle) {
         paperInfo = `📄 Nguồn: ${escHtml(paperTitle)}`;
      }

      physHtml += `
        ${paperInfo ? `<div class="mt-2" style="font-size:0.75rem; color:#a1a1aa; padding:6px; background:rgba(0,0,0,0.2); border-radius:4px; border-left: 2px solid rgba(251,191,36,.3)">${paperInfo}</div>` : ''}
      </div>`;
    } else if (val(ai.physical.polymorphs)) {
      // Fallback for old data format
      const polymorphField = ai.physical.polymorphs;
      const polymorphVal   = val(polymorphField);
      if (polymorphVal && polymorphVal !== 'Chưa có dữ liệu xác minh') {
        const doiUrl  = (typeof polymorphField === 'object' && polymorphField.paperDoi)
          ? `https://doi.org/${polymorphField.paperDoi}` : null;
        const srcUrl  = (typeof polymorphField === 'object' && polymorphField.sourceUrl) || doiUrl;
        const paperTitle = typeof polymorphField === 'object' ? polymorphField.paperTitle : null;
        physHtml += `
        <div class="insight-box mt-2" style="border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.06)">
          <div class="insight-label" style="color:#fbbf24">🔷 Dạng thù hình tinh thể (Polymorphism)</div>
          <p style="line-height:1.75">${linkify(polymorphVal)}</p>
          ${paperTitle ? `<p class="mt-1 text-sm" style="color:var(--text-3)">📄 Tài liệu: ${escHtml(paperTitle)}</p>` : ''}
          ${srcUrl
            ? `<a href="${escHtml(srcUrl)}" target="_blank" rel="noopener"
                style="display:inline-flex;align-items:center;gap:4px;font-size:.7rem;margin-top:6px;padding:3px 10px;border-radius:5px;
                background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3);text-decoration:none">
                🔗 Xem nguồn tài liệu →</a>`
            : `<span style="font-size:.68rem;color:var(--text-3)">⚠️ Chưa có DOI xác minh</span>`}
        </div>`;
      }
    }

    const physicalParts = [];
    if (val(ai.physical.appearance)) {
      physicalParts.push(`<strong>Cảm quan:</strong> ${linkify(val(ai.physical.appearance))} ${srcBadge(ai.physical.appearance, true)}`);
    }
    if (!pcVerifiedRows.some(r => r.includes('Nhiệt độ nóng chảy')) && val(ai.physical.meltingPoint)) {
      physicalParts.push(`<strong>Nhiệt độ nóng chảy:</strong> ${linkify(val(ai.physical.meltingPoint))} ${srcBadge(ai.physical.meltingPoint, true)}`);
    }
    if (!pcVerifiedRows.some(r => r.includes('Độ tan')) && val(ai.physical.solubilityAnalysis || ai.physical.solubility)) {
      const sol = ai.physical.solubilityAnalysis || ai.physical.solubility;
      physicalParts.push(`<strong>Độ tan:</strong> ${linkify(val(sol))} ${srcBadge(sol, true)}`);
    }

    physHtml += `<div class="insight-box mt-2">
      <div class="insight-label">🤖 AI Phân tích tính chất vật lý</div>
      <p class="mt-1 text-sm" style="line-height:1.7">
        ${physicalParts.join(' &nbsp;•&nbsp; ')}
      </p>
    </div>`;
  }

  setInner('sec-physical', physHtml || '<p class="text-3 text-sm">Không có dữ liệu – hãy tra cứu AI phân tích.</p>');

  // ── 1.3 Chemical Properties ──────────────────────────────────────────
  const _chemblId  = pc?.chemblId || '';
  const chemblUrl2 = ai?._chemblUrl || `https://www.ebi.ac.uk/chembl/compound_report_card/${_chemblId}/`;
  // exp đã khai báo ở đầu hàm (line 250) – dùng trực tiếp
  const chemblPka  = exp.pka || [];
  const aiPkaField = ai?.chemical?.pka;
  const cid2       = ai?._pubchemCid;

  // Dòng tóm tắt số liệu ChEMBL (đã xác minh)
  const chemNums = [
    p.XLogP  != null ? `LogP: <strong>${p.XLogP}</strong> <a href="${escHtml(chemblUrl2)}" target="_blank" style="font-size:.6rem;color:#818cf8">ChEMBL→</a>` : null,
    exp.logD?.[0]    ? `LogD: <strong>${escHtml(exp.logD[0])}</strong>` : null,
  ].filter(Boolean);

  let chemHtml = chemNums.length
    ? `<p style="color:var(--text-2);font-size:.85rem;line-height:2;margin-bottom:.5rem">${chemNums.join(' &nbsp;·&nbsp; ')}</p>`
    : '';

  // PubChem pKa (xác minh)
  const pcPka = rawPc.pka || [];
  if (pcPka.length) {
    chemHtml += `<div class="insight-box mt-2" style="border-color:rgba(34,197,94,.3);background:rgba(34,197,94,.05)">
      <div class="insight-label" style="color:#4ade80">✅ pKa từ PubChem CID ${escHtml(String(cid2 || ''))}</div>
      ${pcPka.map(item => `<p class="mt-1 text-sm" style="line-height:1.7">
        ${escHtml(item.value)}
        <a href="${escHtml(item.sourceUrl)}" target="_blank" rel="noopener"
          style="display:inline-flex;align-items:center;gap:3px;font-size:.62rem;padding:1px 6px;border-radius:4px;
          background:rgba(34,197,94,.12);color:#4ade80;border:1px solid rgba(34,197,94,.3);
          text-decoration:none;margin-left:4px">🟢 Xác minh →</a>
      </p>`).join('')}
    </div>`;
  }

  if (ai?.chemical) {
    chemHtml += `<div class="insight-box purple mt-2">
      <div class="insight-label purple">🤖 AI Phân tích tính chất hóa học</div>
      ${row('Tính acid/base', ai.chemical.acidBaseNature)}
      ${!pcPka.length ? row('pKa', aiPkaField || ai.chemical.pkaValues) : ''}
      ${row('Độ ổn định', ai.chemical.stabilityOverview)}
    </div>`;
  }

  setInner('sec-chemical', chemHtml);

  // ── 1.4 Biological Properties ─────────────────────────────────────────────────
  let bioHtml = '';

  if (ai?.biological) {
    bioHtml += `
    <div class="insight-box green mt-2">
      <div class="insight-label green">🤖 AI Phân tích tính chất sinh học</div>
      ${row('LogP', ai.biological.logP)}
      ${row('Phân loại BCS', ai.biological.bcsClass)}
    </div>`;
  }

  // Cơ chế tác dụng từ ChEMBL
  if (state.drugData?.mechanisms?.length) {
    bioHtml += `<div class="mt-2">
      <div class="data-item-label" style="margin-bottom:6px">Cơ chế tác dụng (ChEMBL)
        <a href="${escHtml(chemblUrl2)}" target="_blank" rel="noopener"
          style="font-size:.6rem;padding:1px 5px;border-radius:4px;background:rgba(34,197,94,.12);
          color:#4ade80;border:1px solid rgba(34,197,94,.3);text-decoration:none;margin-left:6px">🟢 ChEMBL →</a>
      </div>
      <div class="tag-cloud">${state.drugData.mechanisms.map((m) =>
        `<span class="tag tag-green">${escHtml(m.mechanism_of_action || m.action_type)}</span>`).join('')}
      </div>
    </div>`;
  }

  setInner('sec-biological', bioHtml);
}


// ── Render: Stability Tab ─────────────────────────────────────────────────────

function renderStabilityTab() {
  const d = state.stabilityData;
  if (!d) return;

  const conditions = [
    { key: 'acidDegradation',      name: 'Acid',             icon: '🧪', color: 'icon-red'   },
    { key: 'alkalineDegradation',  name: 'Kiềm (Alkaline)', icon: '💧', color: 'icon-blue'  },
    { key: 'oxidativeDegradation', name: 'Chất oxy hóa',    icon: '⚡', color: 'icon-amber' },
    { key: 'thermalDegradation',   name: 'Nhiệt độ',        icon: '🌡️', color: 'icon-red'   },
    { key: 'photoDegradation',     name: 'Ánh sáng',        icon: '☀️', color: 'icon-amber' },
    { key: 'hydrolysisDegradation',name: 'Thủy phân',       icon: '💦', color: 'icon-cyan'  },
  ];

  // Badge nguồn dữ liệu
  const modeLabel = {
    'semantic-scholar': '📚 Semantic Scholar',
    'crossref':         '📖 CrossRef/DOI',
    'full-search':      '🌐 Web Search',
    'ai-knowledge':     '🤖 AI Knowledge',
  }[d.searchMode || d.mode || 'ai-knowledge'] || '🤖 AI Knowledge';

  let html = `<div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.8rem">
    <span class="tag tag-cyan" style="font-size:.72rem">${modeLabel}</span>
    ${(d.rawPapers?.length || 0) > 0 ? `<a href="#reference-list-section" class="tag tag-blue" style="font-size:.72rem; text-decoration: none; cursor: pointer; transition: opacity 0.2s;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">📄 ${d.rawPapers.length} bài báo tìm được (Click để xem) ⬇️</a>` : ''}
  </div>`;

  if (d.overview) {
    html += `<div class="insight-box amber" style="margin-bottom:1rem">
      <div class="insight-label amber">📋 Tổng quan từ bài báo</div>
      <p>${escHtml(d.overview)}</p>
    </div>`;
  }

  if (d.stablePhRange) {
    html += `<div class="insight-box purple" style="margin-bottom:1.5rem">
      <div class="insight-label purple">🧪 Dải pH ổn định</div>
      <div style="margin-bottom:6px"><strong>Dải pH:</strong> <span class="tag tag-purple">${escHtml(d.stablePhRange.range)}</span></div>
      <p style="white-space: pre-line; line-height: 1.6; font-size: 0.9rem;">${escHtml(d.stablePhRange.details)}</p>
      ${d.stablePhRange.reference ? `<div style="margin-top:8px; border-top:1px solid rgba(168,85,247,.2); padding-top:6px;"><span class="stability-row-label" style="color:#c084fc">📎 Nguồn:</span> <span class="stability-row-val" style="font-size:.75rem;color:#e9d5ff">${renderRef(d.stablePhRange.reference)}</span></div>` : ''}
      ${d.stablePhRange.quote ? `<div style="margin-top:6px; background:rgba(255,255,255,0.03); border-radius:4px; padding:6px; font-style:italic; border-left: 2px solid rgba(168,85,247,.4)"><span style="font-size:.75rem;color:#d8b4fe">" ${escHtml(d.stablePhRange.quote)} "</span></div>` : ''}
    </div>`;
  }

  html += '<div class="stability-grid">';
  for (const c of conditions) {
    const data = d[c.key];
    if (!data) continue;
    html += `
      <div class="stability-item">
        <div class="stability-header">
          <div class="section-icon ${c.color}" style="width:28px;height:28px;font-size:.85rem">${c.icon}</div>
          <div class="stability-name">${escHtml(c.name)}</div>
        </div>
        ${data.conditions ? `<div class="stability-row"><span class="stability-row-label">Điều kiện:</span><span class="stability-row-val">${linkify(data.conditions)}</span></div>` : ''}
        ${data.rate       ? `<div class="stability-row"><span class="stability-row-label">Mức phân hủy:</span><span class="stability-row-val">${escHtml(data.rate)}</span></div>` : ''}
        ${data.products   ? `<div class="stability-row"><span class="stability-row-label">SP phân hủy:</span><span class="stability-row-val">${escHtml(data.products)}</span></div>` : ''}
        ${data.mechanism  ? `<div class="stability-row"><span class="stability-row-label">Cơ chế:</span><span class="stability-row-val">${escHtml(data.mechanism)}</span></div>` : ''}
        ${data.reference  ? `<div class="stability-row" style="border-top:1px solid rgba(99,102,241,.15);margin-top:6px;padding-top:6px">
          <span class="stability-row-label" style="color:#818cf8">📎 Nguồn:</span>
          <span class="stability-row-val" style="font-size:.73rem;color:#a5b4fc;line-height:1.6">
            ${escHtml(data.reference)}
          </span>
        </div>` : ''}
        ${data.quote      ? `<div style="margin-top:6px; background:rgba(255,255,255,0.02); border-radius:4px; padding:6px; font-style:italic; border-left: 2px solid rgba(99,102,241,.3)">
          <span style="font-size:.73rem;color:#94a3b8;line-height:1.5">" ${escHtml(data.quote)} "</span>
        </div>` : ''}
      </div>`;
  }
  html += '</div>';

  if (d.mainDegradationProducts?.length) {
    html += `<div class="mt-2">
      <div class="data-item-label" style="margin-bottom:8px">Sản phẩm phân hủy chính</div>
      <div class="tag-cloud">${d.mainDegradationProducts.map((p) => `<span class="tag tag-amber">${escHtml(p)}</span>`).join('')}</div>
    </div>`;
  }

  if (d.analyticMethod) {
    html += `<div class="insight-box mt-2"><div class="insight-label">🔬 Phương pháp phân tích</div><p>${escHtml(d.analyticMethod)}</p></div>`;
  }

  if (d.conclusion) {
    html += `<div class="insight-box green mt-2"><div class="insight-label green">✅ Kết luận</div><p>${escHtml(d.conclusion)}</p></div>`;
  }

  // Danh sách bài báo tìm được
  const allPapers = (d.rawPapers && d.rawPapers.length > 0) ? d.rawPapers : (d.papers || []);
  if (allPapers.length) {
    const citedUrls = d.citedUrls || [];
    const readPapers = [];
    const unreadPapers = [];
    
    html += `<div id="reference-list-section" style="padding-top: 10px;"></div>`;
    
    for (const p of allPapers) {
      let isCited = false;
      if (p.url && citedUrls.some(url => url && url.includes(p.url))) {
        isCited = true;
      }
      
      if (isCited) readPapers.push(p);
      else unreadPapers.push(p);
    }

    if (readPapers.length) {
      html += `<div class="mt-2" style="margin-bottom: 20px;">
        <div class="data-item-label" style="margin-bottom:10px; color: #60a5fa;">📄 Các bài báo được AI sử dụng làm Trích dẫn (${readPapers.length})</div>
        <div class="source-links">
          ${readPapers.map((p, i) => `
            <div class="source-link-item" style="margin-bottom: 12px; padding: 10px; background: rgba(255,255,255,0.03); border-radius: 6px; border-left: 3px solid #3b82f6;">
              <div style="font-weight: 600; color: #e2e8f0; font-size: 0.85rem; margin-bottom: 4px;">
                <span style="color: #60a5fa;">[${i + 1}]</span>
                ${p.url
                  ? `<a href="${escHtml(p.url)}" target="_blank" rel="noopener" style="color: #e2e8f0; text-decoration: none;">${escHtml(p.title || 'Xem bài báo')}</a>`
                  : `<span>${escHtml(p.title || '')}</span>`
                }
              </div>
              ${p.url ? `<div style="font-size: 0.75rem; color: #94a3b8; word-break: break-all;">
                <span style="color: #818cf8; font-weight: 500;">🔗 URL:</span> 
                <a href="${escHtml(p.url)}" target="_blank" rel="noopener" style="color: #94a3b8; text-decoration: underline;">${escHtml(p.url)}</a>
              </div>` : ''}
              ${p.doi ? `<div style="font-size: 0.75rem; color: #94a3b8; word-break: break-all; margin-top: 2px;">
                <span style="color: #10b981; font-weight: 500;">📌 DOI:</span> 
                <a href="https://doi.org/${escHtml(p.doi)}" target="_blank" rel="noopener" style="color: #94a3b8; text-decoration: underline;">${escHtml(p.doi)}</a>
              </div>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
    }

    if (unreadPapers.length) {
      html += `<div class="mt-2" style="margin-bottom: 20px;">
        <div class="data-item-label" style="margin-bottom:10px; color: #fbbf24;">📚 Recommend đọc thêm (Các bài báo AI đã quét nhưng không sử dụng) (${unreadPapers.length})</div>
        <div class="source-links">
          ${unreadPapers.map((p, i) => `
            <div class="source-link-item" style="margin-bottom: 12px; padding: 10px; background: rgba(251, 191, 36, 0.05); border-radius: 6px; border-left: 3px solid #fbbf24; opacity: 0.8;">
              <div style="font-weight: 600; color: #fde68a; font-size: 0.85rem; margin-bottom: 4px;">
                <span style="color: #fbbf24;">[${i + 1}]</span>
                ${p.url
                  ? `<a href="${escHtml(p.url)}" target="_blank" rel="noopener" style="color: #fde68a; text-decoration: none;">${escHtml(p.title || 'Xem bài báo')}</a>`
                  : `<span>${escHtml(p.title || '')}</span>`
                }
              </div>
              ${p.url ? `<div style="font-size: 0.75rem; color: #94a3b8; word-break: break-all;">
                <span style="color: #fbbf24; font-weight: 500;">🔗 URL:</span> 
                <a href="${escHtml(p.url)}" target="_blank" rel="noopener" style="color: #94a3b8; text-decoration: underline;">${escHtml(p.url)}</a>
              </div>` : ''}
              ${p.doi ? `<div style="font-size: 0.75rem; color: #94a3b8; word-break: break-all; margin-top: 2px;">
                <span style="color: #10b981; font-weight: 500;">📌 DOI:</span> 
                <a href="https://doi.org/${escHtml(p.doi)}" target="_blank" rel="noopener" style="color: #94a3b8; text-decoration: underline;">${escHtml(p.doi)}</a>
              </div>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
    }
  }

  setInner('sec-stability', html);

  // Ẩn sources card cũ nếu đã hiển thị trong nội dung
  if (d.searchLinks?.length && !allPapers.length) {
    show('stability-sources-card');
    setInner('sec-stability-sources', `<div class="source-links">${
      d.searchLinks.slice(0, 10).map((l, i) => `
        <div class="source-link-item">
          <div class="source-link-num">${i + 1}</div>
          <div class="source-link-text">
            <a href="${escHtml(l.url)}" target="_blank" rel="noopener" class="source-link-title">${escHtml(l.title)}</a>
            <span class="source-link-url">${escHtml(l.url)}</span>
          </div>
        </div>`).join('')
    }</div>`);
  }
}

function renderStabilityError(msg) {
  setInner('sec-stability', errorBox(msg));
}



// ── Render: SRA Tab ───────────────────────────────────────────────────────────

function renderSRATab() {
  const d = state.sraData;
  if (!d) return;

  const products = d.products || [];
  setInner('sra-count', products.length + ' sản phẩm');

  if (d.rawContent && !products.length) {
    setInner('sec-sra-products', `
      <div class="insight-box amber"><div class="insight-label amber">⚠️ Dữ liệu thô</div>${escHtml(d.rawContent)}</div>
    `);
    return;
  }

  if (!products.length) {
    setInner('sec-sra-products', '<p class="text-3 text-sm" style="padding:1rem">Không tìm thấy sản phẩm phù hợp.</p>');
    return;
  }

  const productsHtml = products.map((pr) => `
    <div class="product-card">
      <div>
        <div class="product-name">${escHtml(pr.productName || 'Không rõ tên')}</div>
        <div class="product-meta">
          ${pr.manufacturer ? `🏭 ${escHtml(pr.manufacturer)}` : ''}
          ${pr.country ? ` &nbsp;•&nbsp; 🌍 ${escHtml(pr.country)}` : ''}
          ${pr.registrationNumber ? ` &nbsp;•&nbsp; 📋 ${escHtml(pr.registrationNumber)}` : ''}
        </div>
        <div class="stability-row">
          <span class="stability-row-label">Hoạt chất:</span>
          <span class="stability-row-val">${escHtml(pr.activeIngredient || '–')}</span>
        </div>
        <div class="stability-row">
          <span class="stability-row-label">Dạng bào chế:</span>
          <span class="stability-row-val">${escHtml(pr.dosageForm || '–')}</span>
        </div>
        <div class="stability-row">
          <span class="stability-row-label">Hàm lượng:</span>
          <span class="stability-row-val">${escHtml(pr.strength || '–')}</span>
        </div>
        ${pr.excipients?.length ? `
        <div style="margin-top:.6rem">
          <div class="data-item-label" style="margin-bottom:5px">Tá dược:</div>
          <div class="excipients-list">
            ${pr.excipients.map((e) => `<span class="excipient-tag">${escHtml(e)}</span>`).join('')}
          </div>
        </div>` : ''}
        ${pr.manufacturingProcess ? `
        <div style="margin-top:.8rem; padding: .6rem; background: rgba(168,85,247,.08); border-left: 3px solid #a855f7; border-radius: 4px;">
          <div class="data-item-label" style="margin-bottom:5px; color: #c084fc;">⚙️ Quy trình bào chế đề xuất:</div>
          <div style="font-size: 0.85rem; line-height: 1.6; color: #e2e8f0; white-space: pre-line;">${escHtml(pr.manufacturingProcess)}</div>
        </div>` : ''}
      </div>
      <div>
        ${pr.sourceUrl 
           ? `<a href="${escHtml(pr.sourceUrl)}" target="_blank" rel="noopener" style="text-decoration:none"><div class="product-badge" style="background:rgba(59,130,246,.15);color:var(--blue);cursor:pointer">${escHtml(pr.source)} 🔗</div></a>` 
           : (pr.source ? `<div class="product-badge">${escHtml(pr.source)}</div>` : '')
        }
      </div>
    </div>
  `).join('');

  setInner('sec-sra-products', `<div class="product-list">${productsHtml}</div>`);

  // Insights
  if (d.commonExcipients?.length || d.formulationInsights) {
    show('sra-insights-card');
    let insightHtml = '';
    if (d.formulationInsights) {
      insightHtml += `<div class="insight-box purple mt-2" style="margin-bottom:1rem;"><div class="insight-label purple">🤖 Đề xuất công thức tối ưu</div>${escHtml(d.formulationInsights)}</div>`;
    }
    if (d.commonExcipients?.length) {
      insightHtml += `
        <div class="data-item-label" style="margin-bottom:6px">Tá dược cốt lõi phổ biến</div>
        <div class="tag-cloud">${d.commonExcipients.map((e) => `<span class="tag tag-purple">${escHtml(e)}</span>`).join('')}</div>
      `;
    }
    if (d.dataQuality) {
      insightHtml += `<div class="insight-box amber mt-2"><div class="insight-label amber">📊 Chất lượng dữ liệu</div>${escHtml(d.dataQuality)}</div>`;
    }
    setInner('sec-sra-insights', insightHtml);
  }
}

function renderSRAError(msg) {
  setInner('sec-sra-products', errorBox(msg));
}

// ── Render: Patents Tab ───────────────────────────────────────────────────────

function renderPatentsTab() {
  const d = state.patentData;
  if (!d) return;

  const patents = d.patents || [];
  setInner('patent-count', patents.length + ' patent');

  if (!patents.length) {
    setInner('sec-patents', '<p class="text-3 text-sm" style="padding:1rem">Không tìm thấy patent phù hợp.</p>');
  } else {
    const patentHtml = patents.map((pt) => `
      <div class="patent-card">
        <div class="patent-number">${escHtml(pt.patentNumber || 'Patent')}</div>
        <div class="patent-title">${escHtml(pt.title || '–')}</div>
        <div class="patent-applicant">
          ${pt.applicant ? `🏢 ${escHtml(pt.applicant)}` : ''}
          ${pt.filingDate ? ` &nbsp;•&nbsp; 📅 Nộp đơn: ${escHtml(pt.filingDate)}` : ''}
          ${pt.publicationDate ? ` &nbsp;•&nbsp; 📢 Công bố: ${escHtml(pt.publicationDate)}` : ''}
        </div>
        ${pt.dosageForm ? `<div class="stability-row"><span class="stability-row-label">Dạng bào chế:</span><span class="stability-row-val">${escHtml(pt.dosageForm)}</span></div>` : ''}
        ${pt.composition ? `
        <div class="divider"></div>
        <div class="patent-composition-label">📋 Chi tiết cấu trúc công thức</div>
        
        ${pt.composition.examplesSummary ? `<div class="insight-box mt-2"><div class="insight-label">🧪 Tóm tắt các ví dụ (Examples)</div><p style="white-space:pre-line;line-height:1.6">${escHtml(pt.composition.examplesSummary)}</p></div>` : ''}
        
        ${pt.composition.selectionMethod ? `<div class="insight-box mt-2"><div class="insight-label">🔬 Phương pháp chọn công thức tối ưu</div><p style="white-space:pre-line;line-height:1.6">${escHtml(pt.composition.selectionMethod)}</p></div>` : ''}

        ${pt.composition.optimalFormula ? `<div class="insight-box mt-2"><div class="insight-label">💎 Công thức tối ưu nhất (Preferred Embodiment)</div><p style="white-space:pre-line;line-height:1.6">${escHtml(pt.composition.optimalFormula)}</p></div>` : ''}

        ${pt.composition.manufacturingProcess ? `<div class="insight-box mt-2"><div class="insight-label">⚙️ Quy trình bào chế</div><p style="white-space:pre-line;line-height:1.6">${escHtml(pt.composition.manufacturingProcess)}</p></div>` : ''}
        
        ${pt.composition.innovativeFeatures ? `<div class="insight-box green mt-2"><div class="insight-label green">✨ Điểm đặc biệt</div>${escHtml(pt.composition.innovativeFeatures)}</div>` : ''}
        ` : ''}
        ${pt.claims ? `<div class="insight-box purple mt-2"><div class="insight-label purple">⚖️ Claims chính</div>${escHtml(pt.claims)}</div>` : ''}
        ${pt.url ? `<a href="${escHtml(pt.url)}" target="_blank" rel="noopener" class="patent-link">🔗 Xem patent gốc</a>` : ''}
      </div>
    `).join('');

    setInner('sec-patents', patentHtml);
  }

  // Insights
  if (d.formulationTrends || d.keyExcipients?.length || d.innovationInsights || d.patentLandscape) {
    show('patent-insights-card');
    let insightHtml = '';
    if (d.keyExcipients?.length) {
      insightHtml += `
        <div class="data-item-label" style="margin-bottom:6px">Tá dược xuất hiện nhiều nhất trong patent</div>
        <div class="tag-cloud">${d.keyExcipients.map((e) => `<span class="tag tag-amber">${escHtml(e)}</span>`).join('')}</div>
      `;
    }
    if (d.formulationTrends) insightHtml += `<div class="insight-box mt-2"><div class="insight-label">📈 Xu hướng công thức</div>${escHtml(d.formulationTrends)}</div>`;
    if (d.innovationInsights) insightHtml += `<div class="insight-box green mt-2"><div class="insight-label green">💡 Đổi mới</div>${escHtml(d.innovationInsights)}</div>`;
    if (d.patentLandscape) insightHtml += `<div class="insight-box purple mt-2"><div class="insight-label purple">🗺️ Bức tranh patent</div>${escHtml(d.patentLandscape)}</div>`;
    setInner('sec-patent-insights', insightHtml);
  }

  // Raw links
  if (d.rawLinks?.length) {
    show('patent-links-card');
    setInner('sec-patent-links', `<div class="source-links">${
      d.rawLinks.slice(0, 10).map((l, i) => `
        <div class="source-link-item">
          <div class="source-link-num">${i + 1}</div>
          <div class="source-link-text">
            <a href="${escHtml(l.url)}" target="_blank" rel="noopener" class="source-link-title">${escHtml(l.title)}</a>
            <span class="source-link-url">${escHtml(l.url)}</span>
          </div>
        </div>`).join('')
    }</div>`);
  }
}

function renderPatentsError(msg) {
  setInner('sec-patents', errorBox(msg));
}

// ── Error Box ─────────────────────────────────────────────────────────────────

function errorBox(msg) {
  return `<div class="error-box"><span>❌</span><span>${escHtml(msg)}</span></div>`;
}

// ── Keyboard shortcut ─────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.target.id === 'drug-name' || e.target.id === 'dosage-form')) {
    startSearch();
  }
});

// ── Key Persistence & Defaults ────────────────────────────────────────────────
const DEFAULT_OPENAI_KEY = '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';
const DEFAULT_SERPER_KEY = 'e9146f694453f15764f0aa93a2387c6a1f81c5db';

(function initKeys() {
  const savedOpenai = localStorage.getItem('openai_api_key');
  const savedSerper = localStorage.getItem('serper_api_key');

  const openaiEl = document.getElementById('openai-key');
  const serperEl = document.getElementById('serper-key');

  if (openaiEl) {
    openaiEl.value = savedOpenai !== null ? savedOpenai : DEFAULT_OPENAI_KEY;
  }
  if (serperEl) {
    serperEl.value = savedSerper !== null ? savedSerper : DEFAULT_SERPER_KEY;
  }
})();
