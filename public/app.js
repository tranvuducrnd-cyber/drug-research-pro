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
  pharmaData: null,
};

// ── Protocol builder: chọn thông tin (ô tick) → xuất file Word (.docx) ─────────
// Mỗi mẩu thông tin trong các tab đăng ký 1 "block" đã chuẩn hoá vào Map này
// (pid → block). Ô tick mang data-pid; khi bấm "Tạo Protocol" ta gom các pid được
// tick, tra block, gửi lên /api/protocol/export để backend dựng .docx.
const protocolItems = new Map();
const SECTION_META = {
  drug:      { rank: 1, name: 'Tổng quan hoạt chất' },
  clinical:  { rank: 2, name: 'Thông tin dược lý & bào chế' },
  stability: { rank: 3, name: 'Độ ổn định / Phân hủy cưỡng bức' },
  sra:       { rank: 4, name: 'Công thức tham khảo đề xuất' },
  pharma:    { rank: 5, name: 'Tiêu chuẩn chất lượng (Dược điển)' },
  compat:    { rank: 6, name: 'Tương tác hoạt chất – tá dược' },
  patents:   { rank: 7, name: 'Patent tham khảo' },
};

function clearProtocolItems() {
  protocolItems.clear();
  const btn = document.getElementById('btn-protocol');
  if (btn) { btn.disabled = true; btn.textContent = '📝 Tạo Protocol Word (0 mục)'; }
}

// Chuẩn hoá object/array → text đọc được (tránh "[object Object]"). Dùng chung nhiều tab.
const PROTO_KEY_LABEL = {
  adults: 'Người lớn', adult: 'Người lớn', children: 'Trẻ em', child: 'Trẻ em', pediatric: 'Trẻ em',
  elderly: 'Người cao tuổi', renal: 'Suy thận', renalImpairment: 'Suy thận', hepatic: 'Suy gan',
  hepaticImpairment: 'Suy gan', maxDose: 'Liều tối đa', maximum: 'Liều tối đa', administration: 'Cách dùng',
  route: 'Đường dùng', frequency: 'Số lần dùng', duration: 'Thời gian dùng', note: 'Lưu ý', notes: 'Lưu ý',
};
function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    if (v.value !== undefined) return toText(v.value);
    return Object.entries(v).map(([k, val]) => {
      const t = toText(val);
      return t ? `${PROTO_KEY_LABEL[k] || k}: ${t}` : '';
    }).filter(Boolean).join('\n');
  }
  return String(v);
}

// Helper dựng block theo type
function blkText(text)              { return { type: 'text', text: toText(text) }; }
function blkKV(pairs, sources)      { return { type: 'keyvalue', pairs: (pairs || []).filter(p => p && p[1] != null && String(p[1]).trim() !== '').map(p => [String(p[0]), toText(p[1])]), sources }; }
function blkTable(headers, rows, sources) { return { type: 'table', headers, rows, sources }; }
function blkList(items, sources)    { return { type: 'list', items: (items || []).map(toText).filter(Boolean), sources }; }

// Đăng ký 1 block + trả về HTML thanh ô tick (đặt đầu mỗi box thông tin).
function pickBox(sectionKey, pid, heading, block) {
  const meta = SECTION_META[sectionKey] || { rank: 99, name: sectionKey };
  protocolItems.set(pid, Object.assign({ section: meta.name, rank: meta.rank, heading: heading || '' }, block));
  return `<div class="pi-pickbar"><label class="pi-pick"><input type="checkbox" class="pi-check" data-pid="${escHtml(pid)}" onchange="updateProtocolCount()"><span>Đưa vào Protocol</span></label></div>`;
}

function updateProtocolCount() {
  const n = document.querySelectorAll('.pi-check:checked').length;
  const btn = document.getElementById('btn-protocol');
  if (btn) { btn.disabled = n === 0; btn.textContent = `📝 Tạo Protocol Word (${n} mục)`; }
}

function protocolSelectAll(v) {
  document.querySelectorAll('#results-section .pi-check').forEach((c) => { c.checked = v; });
  updateProtocolCount();
}

// Modal nhập thông tin trang bìa rồi xuất Word.
function openProtocolModal() {
  const checked = document.querySelectorAll('.pi-check:checked');
  if (!checked.length) { alert('Vui lòng tick chọn ít nhất 1 mục để đưa vào Protocol.'); return; }

  const today = new Date().toLocaleDateString('vi-VN');
  const defTitle = `Nghiên cứu bào chế ${state.drugName || ''}${state.dosageForm ? ' ' + state.dosageForm : ''}`.trim();

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
  const modal = document.createElement('div');
  modal.style.cssText = 'background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:1.75rem;max-width:480px;width:92%;box-shadow:0 20px 60px rgba(15,23,42,0.25);max-height:90vh;overflow:auto;';
  const field = (id, label, value) => `
    <div style="margin-bottom:0.9rem;text-align:left;">
      <label style="display:block;font-size:0.78rem;font-weight:600;color:#334155;margin-bottom:4px;">${escHtml(label)}</label>
      <input id="${id}" value="${escHtml(value || '')}" style="width:100%;padding:0.55rem 0.7rem;border:1px solid #cbd5e1;border-radius:8px;font-size:0.85rem;box-sizing:border-box;">
    </div>`;
  modal.innerHTML = `
    <div style="text-align:center;margin-bottom:1.2rem;">
      <div style="font-size:2rem;margin-bottom:0.3rem;">📝</div>
      <h3 style="color:#0f172a;margin:0;font-size:1.1rem;">Tạo Protocol nghiên cứu (Word)</h3>
      <p style="color:#64748b;font-size:0.8rem;margin:0.3rem 0 0;">${checked.length} mục đã chọn sẽ được gộp vào tài liệu</p>
    </div>
    ${field('proto-title', 'Tên đề tài', defTitle)}
    ${field('proto-drug', 'Hoạt chất', state.drugName || '')}
    ${field('proto-dosage', 'Dạng bào chế', state.dosageForm || '')}
    ${field('proto-author', 'Người thực hiện', '')}
    ${field('proto-unit', 'Đơn vị / Cơ quan', '')}
    ${field('proto-date', 'Ngày', today)}
    <div style="display:flex;gap:0.75rem;margin-top:1.2rem;">
      <button id="proto-cancel" style="flex:1;padding:0.7rem;border:1px solid #e2e8f0;border-radius:10px;background:transparent;color:#475569;cursor:pointer;font-size:0.85rem;">Hủy</button>
      <button id="proto-ok" style="flex:1.4;padding:0.7rem;border:none;border-radius:10px;background:#2563eb;color:#fff;cursor:pointer;font-size:0.85rem;font-weight:600;">⬇️ Xuất Word (.docx)</button>
    </div>`;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const close = () => { if (overlay.parentNode) document.body.removeChild(overlay); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  modal.querySelector('#proto-cancel').addEventListener('click', close);
  modal.querySelector('#proto-ok').addEventListener('click', async () => {
    const meta = {
      title: modal.querySelector('#proto-title').value.trim(),
      drugName: modal.querySelector('#proto-drug').value.trim(),
      dosageForm: modal.querySelector('#proto-dosage').value.trim(),
      author: modal.querySelector('#proto-author').value.trim(),
      unit: modal.querySelector('#proto-unit').value.trim(),
      date: modal.querySelector('#proto-date').value.trim(),
    };
    const okBtn = modal.querySelector('#proto-ok');
    okBtn.disabled = true; okBtn.textContent = '⏳ Đang tạo...';
    try {
      await exportProtocol(meta);
      close();
    } catch (e) {
      okBtn.disabled = false; okBtn.textContent = '⬇️ Xuất Word (.docx)';
      alert('Lỗi tạo Protocol: ' + e.message);
    }
  });
}

async function exportProtocol(meta) {
  // Gom block theo pid đã tick, sắp xếp theo thứ tự mục lớn (rank), giữ thứ tự trong mục.
  const blocks = [...document.querySelectorAll('.pi-check:checked')]
    .map((c) => protocolItems.get(c.dataset.pid))
    .filter(Boolean)
    .map((b, i) => Object.assign({ _i: i }, b))
    .sort((a, b) => (a.rank - b.rank) || (a._i - b._i));
  if (!blocks.length) throw new Error('Không có mục nào được chọn.');

  const headers = { 'Content-Type': 'application/json' };
  if (supabase) {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
  }
  const res = await fetch('/api/protocol/export', {
    method: 'POST', headers, body: JSON.stringify({ meta, blocks }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Protocol_${(meta.drugName || 'nghien_cuu').replace(/[^\w\-]+/g, '_')}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── Supabase (Auth + Lịch sử) ───────────────────────────────────────────────

let supabase = null;
let currentProfile = null;
let _resolveAppReady;
const appReady = new Promise((resolve) => { _resolveAppReady = resolve; });

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

function switchPage(pageId, btn) {
  document.querySelectorAll('.page-panel').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.sidebar-nav-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById(pageId).classList.add('active');
  if (btn) btn.classList.add('active');
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
    '<a href="$1" target="_blank" rel="noopener" style="color:#4338ca;text-decoration:underline;word-break:break-all">$1</a>'
  );
}

// Render nguồn trích dẫn thành dạng có thể click
function renderRef(ref) {
  if (!ref) return '';
  // Tách DOI nếu có dạng doi.org/... hoặc 10.xxxx/...
  const withDoi = escHtml(ref).replace(
    /(10\.\d{4,}[^\/\s]*)(\/[^\s<&"']+)?/g,
    (match) => `<a href="https://doi.org/${match}" target="_blank" rel="noopener" style="color:#4338ca;text-decoration:underline">${match}</a>`
  );
  // Sau đó linkify URL thường
  return withDoi.replace(
    /(https?:\/\/[^\s<&"']+)/g,
    '<a href="$1" target="_blank" rel="noopener" style="color:#4338ca;text-decoration:underline;word-break:break-all">$1</a>'
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
  { id: 'step-pubchem',     label: 'Tra cứu cấu trúc và tính chất của hoạt chất',    icon: '🔬' },
  { id: 'step-ai',          label: 'AI phân tích: polymorph, pKa, đặc điểm',          icon: '🤖' },
  { id: 'step-stability',   label: 'Phân hủy cưỡng bức (Forced Degradation)',         icon: '🔥' },
  { id: 'step-sra',         label: 'Tra cứu công thức tham khảo đề xuất',            icon: '🧪' },
  { id: 'step-patents',     label: 'Tìm kiếm patent thuốc (Google Patents, WIPO, Serper)', icon: '📄' },
  { id: 'step-pharma',      label: 'Tra cứu dược điển (USP / BP / EP / JP)',          icon: '📖' },
  { id: 'step-compatibility', label: 'Tương tác hoạt chất - tá dược (PharmDE)',       icon: '🤝' },
  { id: 'step-clinical',    label: 'Tra cứu thông tin dược lý & bào chế',             icon: '📋' },
];

const STEP_TO_SECTION = {
  'step-pubchem': 'drug', 'step-ai': 'drug', 'step-stability': 'stability',
  'step-sra': 'sra', 'step-patents': 'patents', 'step-pharma': 'pharma',
  'step-compatibility': 'compatibility', 'step-clinical': 'clinical',
};

function renderProgressSteps(selected) {
  const container = document.getElementById('progress-steps');
  const steps = selected
    ? STEPS.filter(s => selected[STEP_TO_SECTION[s.id]] || (s.id === 'step-pubchem' && selected.compatibility))
    : STEPS;
  container.innerHTML = steps.map((s) => {
    return `
      <div class="progress-step" id="${s.id}">
        <span class="step-icon">${s.icon}</span>
        <div class="progress-step-content">
          <div class="progress-step-header">
            <span class="progress-step-title">${s.label}</span>
            <span class="progress-step-percent" id="${s.id}-percent">0%</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar-fill" id="${s.id}-bar" style="width: 0%"></div>
          </div>
          <div class="progress-detail" id="${s.id}-detail">Đang chờ...</div>
        </div>
      </div>
    `;
  }).join('');
}

function setStepStatus(id, status, extraText = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('active', 'done', 'error');
  el.classList.add(status);
  const label = el.querySelector('.progress-step-title');
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
    // set to 100% on done
    const percentEl = document.getElementById(`${id}-percent`);
    const barEl = document.getElementById(`${id}-bar`);
    const detailEl = document.getElementById(`${id}-detail`);
    if (percentEl) percentEl.textContent = '100%';
    if (barEl) barEl.style.width = '100%';
    if (detailEl) detailEl.textContent = 'Hoàn thành.';
  } else if (status === 'error') {
    icon.textContent = '❌';
    const percentEl = document.getElementById(`${id}-percent`);
    const barEl = document.getElementById(`${id}-bar`);
    const detailEl = document.getElementById(`${id}-detail`);
    if (percentEl) percentEl.textContent = 'Lỗi';
    if (barEl) barEl.style.width = '100%';
    if (detailEl) detailEl.textContent = 'Tiến trình thất bại: ' + extraText;
  }
}

let progressInterval = null;
function startProgressPolling(searchId) {
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/progress?id=${searchId}`);
      const data = await res.json();
      
      if (data.properties) {
        updateStepProgressBar('step-pubchem', data.properties.percent, data.properties.message);
      }
      if (data.aiAnalysis) {
        updateStepProgressBar('step-ai', data.aiAnalysis.percent, data.aiAnalysis.message);
      }
      if (data.stability) {
        updateStepProgressBar('step-stability', data.stability.percent, data.stability.message);
      }
      if (data.vidal) {
        updateStepProgressBar('step-sra', data.vidal.percent, data.vidal.message);
      }
      if (data.patents) {
        updateStepProgressBar('step-patents', data.patents.percent, data.patents.message);
      }
      if (data.compatibility) {
        updateStepProgressBar('step-compatibility', data.compatibility.percent, data.compatibility.message);
      }
    } catch (e) {
      console.error('Error polling progress:', e);
    }
  }, 800);
}

function stopProgressPolling() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
}

function updateStepProgressBar(id, percent, message) {
  // Only update if the step is currently active (to prevent overwriting done/error state)
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('active')) return;

  const percentEl = document.getElementById(`${id}-percent`);
  const barEl = document.getElementById(`${id}-bar`);
  const detailEl = document.getElementById(`${id}-detail`);
  if (percentEl) percentEl.textContent = `${percent}%`;
  if (barEl) barEl.style.width = `${percent}%`;
  if (detailEl) detailEl.textContent = message;

  // Cập nhật thanh tiến độ bên trong tab panel nếu có
  const tabPercentEl = document.getElementById(`${id}-tab-percent`);
  const tabBarEl = document.getElementById(`${id}-tab-bar`);
  const tabDetailEl = document.getElementById(`${id}-tab-detail`);
  if (tabPercentEl) tabPercentEl.textContent = `${percent}%`;
  if (tabBarEl) tabBarEl.style.width = `${percent}%`;
  if (tabDetailEl) tabDetailEl.textContent = message;
}

// ── API Calls ─────────────────────────────────────────────────────────────────

async function api(endpoint, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (supabase) {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Drug Name Suggestion Modal ────────────────────────────────────────────────

function showConfirmModal(title, message, confirmLabel = 'Tiếp tục', cancelLabel = 'Hủy') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:2rem;max-width:440px;width:90%;box-shadow:0 20px 60px rgba(15,23,42,0.25);';

    modal.innerHTML = `
      <div style="text-align:center;margin-bottom:1.5rem;">
        <div style="font-size:2.5rem;margin-bottom:0.5rem;">⚠️</div>
        <h3 style="color:#0f172a;margin:0 0 0.5rem 0;font-size:1.15rem;">${escHtml(title)}</h3>
        <p style="color:#475569;font-size:0.88rem;margin:0;white-space:pre-line;">${escHtml(message)}</p>
      </div>
      <div style="display:flex;gap:0.75rem;">
        <button id="confirm-cancel" style="flex:1;padding:0.7rem;border:1px solid #e2e8f0;border-radius:10px;background:transparent;color:#475569;cursor:pointer;font-size:0.85rem;">${escHtml(cancelLabel)}</button>
        <button id="confirm-ok" style="flex:1;padding:0.7rem;border:none;border-radius:10px;background:#2563eb;color:#fff;cursor:pointer;font-size:0.85rem;font-weight:600;">${escHtml(confirmLabel)}</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = (result) => { document.body.removeChild(overlay); resolve(result); };
    modal.querySelector('#confirm-ok').addEventListener('click', () => close(true));
    modal.querySelector('#confirm-cancel').addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
  });
}

function showDrugSuggestionModal(originalName, suggestions) {
  return new Promise((resolve) => {
    // Tạo overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-2,#ffffff);border:1px solid var(--border,#e2e8f0);border-radius:16px;padding:2rem;max-width:480px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5);';

    let html = `
      <div style="text-align:center;margin-bottom:1.5rem;">
        <div style="font-size:2.5rem;margin-bottom:0.5rem;">⚠️</div>
        <h3 style="color:var(--text-1,#fff);margin:0 0 0.5rem 0;font-size:1.2rem;">Không tìm thấy hoạt chất</h3>
        <p style="color:var(--text-3,#888);font-size:0.9rem;margin:0;">
          Không tìm thấy <strong style="color:var(--red,#ff6b6b);">"${originalName}"</strong> trên PubChem/ChEMBL.<br>
          Có phải bạn muốn tìm:
        </p>
      </div>
      <div style="display:flex;flex-direction:column;gap:0.5rem;max-height:300px;overflow-y:auto;margin-bottom:1.5rem;">
    `;

    suggestions.forEach((s) => {
      html += `<button class="suggestion-btn" data-name="${s}" style="
        padding:0.75rem 1rem;border:1px solid var(--border,#e2e8f0);border-radius:10px;
        background:var(--bg-3,#f8fafc);color:var(--text-1,#fff);cursor:pointer;
        text-align:left;font-size:0.95rem;transition:all 0.2s ease;
      " onmouseover="this.style.background='var(--blue,#4361ee)';this.style.borderColor='var(--blue,#4361ee)';"
         onmouseout="this.style.background='var(--bg-3,#f8fafc)';this.style.borderColor='var(--border,#e2e8f0)';">
        💊 ${s}
      </button>`;
    });

    html += `</div>
      <div style="display:flex;gap:0.75rem;">
        <button id="modal-continue" style="
          flex:1;padding:0.7rem;border:1px solid var(--border,#e2e8f0);border-radius:10px;
          background:transparent;color:var(--text-2,#aaa);cursor:pointer;font-size:0.85rem;
        ">Tiếp tục với "${originalName}"</button>
        <button id="modal-cancel" style="
          flex:1;padding:0.7rem;border:none;border-radius:10px;
          background:var(--red,#ff6b6b);color:#fff;cursor:pointer;font-size:0.85rem;font-weight:600;
        ">Hủy bỏ</button>
      </div>
    `;

    modal.innerHTML = html;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Gắn event cho các nút gợi ý
    modal.querySelectorAll('.suggestion-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.body.removeChild(overlay);
        resolve(btn.dataset.name);
      });
    });

    modal.querySelector('#modal-continue').addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve(originalName); // Tiếp tục với tên gốc
    });

    modal.querySelector('#modal-cancel').addEventListener('click', () => {
      document.body.removeChild(overlay);
      resolve(null); // Hủy tìm kiếm
    });

    // Nhấn ngoài modal để hủy
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
        resolve(null);
      }
    });
  });
}

// ── Auth: Đăng nhập / Đăng ký / Chờ duyệt ──────────────────────────────────────
// Đăng nhập là bắt buộc: modal này không cho đóng bằng click ra ngoài, không có nút Hủy.

let authOverlayEl = null;

function removeAuthOverlay() {
  if (authOverlayEl && authOverlayEl.parentNode) authOverlayEl.parentNode.removeChild(authOverlayEl);
  authOverlayEl = null;
}

function showAuthModal() {
  removeAuthOverlay();

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#9ca3af;z-index:10000;display:flex;align-items:center;justify-content:center;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:#ffffff;border-radius:14px;padding:2.25rem 2rem;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);';

  const rememberedEmail = localStorage.getItem('remembered_email') || '';

  modal.innerHTML = `
    <div style="text-align:center;margin-bottom:1.1rem;">
      <svg viewBox="0 0 300 130" style="width:54px;height:auto;margin:0 auto 0.6rem;display:block;" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="authDtpGrad" x1="10%" y1="0%" x2="90%" y2="100%">
            <stop offset="0%" stop-color="#7a0f1d"/>
            <stop offset="28%" stop-color="#c81e33"/>
            <stop offset="46%" stop-color="#f45a68"/>
            <stop offset="58%" stop-color="#c81e33"/>
            <stop offset="100%" stop-color="#5c0c17"/>
          </linearGradient>
        </defs>
        <text x="0" y="102" font-family="'Arial Black',Arial,sans-serif" font-weight="900" font-size="122" letter-spacing="-16" fill="url(#authDtpGrad)">DTP</text>
      </svg>
      <h3 style="color:#6d28d9;margin:0 0 0.35rem 0;font-size:1.35rem;font-weight:800;">Hỗ trợ nghiên cứu</h3>
      <p style="color:#64748b;font-size:0.85rem;margin:0;">Hệ thống nghiên cứu &amp; phân tích dược phẩm</p>
    </div>
    <div style="height:1px;background:#e2e8f0;margin-bottom:1.25rem;"></div>
    <div style="display:flex;flex-direction:column;gap:0.85rem;margin-bottom:0.9rem;">
      <input id="auth-email" type="email" placeholder="Email" autocomplete="username" value="${escHtml(rememberedEmail)}" style="padding:0.75rem 1rem;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#1e293b;font-size:0.95rem;" />
      <input id="auth-password" type="password" placeholder="Mật khẩu" autocomplete="current-password" style="padding:0.75rem 1rem;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#1e293b;font-size:0.95rem;" />
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:0.85rem;color:#334155;margin-bottom:1.1rem;cursor:pointer;">
      <input id="auth-remember" type="checkbox" checked style="width:16px;height:16px;accent-color:#7c3aed;cursor:pointer;" />
      Ghi nhớ đăng nhập
    </label>
    <div id="auth-error" style="color:#dc2626;font-size:0.85rem;margin-bottom:0.9rem;min-height:1.2em;"></div>
    <button id="auth-login-btn" style="width:100%;padding:0.8rem;border:none;border-radius:8px;background:#7c3aed;color:#fff;cursor:pointer;font-size:0.95rem;font-weight:700;margin-bottom:1rem;">Đăng Nhập</button>
    <div style="text-align:center;font-size:0.85rem;">
      <a id="auth-signup-btn" href="javascript:void(0)" style="color:#7c3aed;text-decoration:none;font-weight:600;">Chưa có tài khoản? Đăng ký</a>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  authOverlayEl = overlay;

  const errEl = modal.querySelector('#auth-error');
  const emailEl = modal.querySelector('#auth-email');
  const passEl = modal.querySelector('#auth-password');
  const rememberEl = modal.querySelector('#auth-remember');

  const setBusy = (busy) => {
    modal.querySelector('#auth-login-btn').disabled = busy;
  };

  modal.querySelector('#auth-login-btn').addEventListener('click', async () => {
    errEl.textContent = '';
    setBusy(true);
    try {
      const email = emailEl.value.trim();
      const { error } = await supabase.auth.signInWithPassword({ email, password: passEl.value });
      if (error) throw error;
      if (rememberEl.checked) localStorage.setItem('remembered_email', email);
      else localStorage.removeItem('remembered_email');
      // onAuthStateChange sẽ gọi initAuthGate() và tự đóng modal khi thành công
    } catch (e) {
      errEl.textContent = e.message || 'Đăng nhập thất bại.';
    } finally {
      setBusy(false);
    }
  });

  modal.querySelector('#auth-signup-btn').addEventListener('click', async () => {
    errEl.textContent = '';
    setBusy(true);
    try {
      const { error } = await supabase.auth.signUp({ email: emailEl.value.trim(), password: passEl.value });
      if (error) throw error;
      errEl.style.color = 'var(--green,#2dd4bf)';
      errEl.textContent = 'Đăng ký thành công! Tài khoản của bạn đang chờ quản trị viên duyệt.';
    } catch (e) {
      errEl.style.color = 'var(--red,#ff6b6b)';
      errEl.textContent = e.message || 'Đăng ký thất bại.';
    } finally {
      setBusy(false);
    }
  });
}

function showPendingScreen(status) {
  removeAuthOverlay();

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--bg-2,#ffffff);border:1px solid var(--border,#e2e8f0);border-radius:16px;padding:2rem;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5);text-align:center;';

  const isRejected = status === 'rejected';
  modal.innerHTML = `
    <div style="font-size:2.5rem;margin-bottom:0.5rem;">${isRejected ? '⛔' : '⏳'}</div>
    <h3 style="color:var(--text-1,#fff);margin:0 0 0.5rem 0;font-size:1.2rem;">${isRejected ? 'Tài khoản bị từ chối' : 'Đang chờ phê duyệt'}</h3>
    <p style="color:var(--text-3,#888);font-size:0.9rem;margin:0 0 1.5rem 0;">
      ${isRejected
        ? 'Tài khoản của bạn đã bị quản trị viên từ chối.'
        : 'Tài khoản của bạn đã đăng ký thành công và đang chờ quản trị viên duyệt. Vui lòng quay lại sau.'}
    </p>
    <button id="pending-logout-btn" style="padding:0.7rem 1.5rem;border:1px solid var(--border,#e2e8f0);border-radius:10px;background:transparent;color:var(--text-2,#aaa);cursor:pointer;font-size:0.85rem;">Đăng xuất</button>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  authOverlayEl = overlay;

  modal.querySelector('#pending-logout-btn').addEventListener('click', () => handleLogout());
}

async function handleLogout() {
  await supabase.auth.signOut();
}

function updateUserBadge() {
  const badge = document.getElementById('user-badge');
  if (!badge) return;
  if (!currentProfile) { hide('user-badge'); return; }
  setInner('user-badge', `
    <div class="user-badge-email" title="${escHtml(currentProfile.email)}">${escHtml(currentProfile.email)}</div>
    ${currentProfile.role === 'admin' ? '<div class="user-badge-role">Quản trị viên</div>' : ''}
    <button class="user-badge-logout-btn" onclick="handleLogout()"><span>Đăng xuất</span></button>
  `);
  show('user-badge');
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const collapsed = sidebar.classList.toggle('collapsed');
  localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0');
}

if (localStorage.getItem('sidebar_collapsed') === '1') {
  const _sb = document.getElementById('sidebar');
  if (_sb) _sb.classList.add('collapsed');
}

let _hasLandedOnSetup = false;

async function initAuthGate() {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    currentProfile = null;
    updateUserBadge();
    hide('sidebar-admin-btn');
    showAuthModal();
    return;
  }

  const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
  if (error || !profile) {
    // Trường hợp hiếm: chưa kịp tạo profile (trigger). Thử lại sau ít lâu.
    showPendingScreen('pending');
    return;
  }

  if (profile.status !== 'approved') {
    currentProfile = null;
    updateUserBadge();
    hide('sidebar-admin-btn');
    showPendingScreen(profile.status);
    return;
  }

  currentProfile = profile;
  removeAuthOverlay();
  updateUserBadge();
  hide('empty-state');
  show('results-section');
  if (profile.role === 'admin') show('sidebar-admin-btn'); else hide('sidebar-admin-btn');
  // Chỉ tự động chuyển sang trang "Thiết lập báo cáo khả thi" lần đầu đăng nhập —
  // không làm lại mỗi khi Supabase tự làm mới token, tránh bật người dùng ra khỏi
  // trang Lịch sử/Quản trị họ đang xem giữa lúc chạy tra cứu.
  if (!_hasLandedOnSetup) {
    _hasLandedOnSetup = true;
    switchPage('page-setup', document.getElementById('sidebar-setup-btn'));
  }
}

// ── Main Search ───────────────────────────────────────────────────────────────

async function startSearch() {
  const drugName  = document.getElementById('drug-name').value.trim();
  const dosageForm = document.getElementById('dosage-form').value;
  const openaiEl = document.getElementById('openai-key');
  const serperEl = document.getElementById('serper-key');
  const openaiKey = openaiEl ? openaiEl.value.trim() : '';
  const serperKey = serperEl ? serperEl.value.trim() : '';

  if (!drugName) { alert('Vui lòng nhập tên hoạt chất!'); return; }
  if (!dosageForm) { alert('Vui lòng chọn Dạng bào chế!'); return; }

  const selected = {
    drug: document.getElementById('cb-drug').checked,
    stability: document.getElementById('cb-stability').checked,
    sra: document.getElementById('cb-sra').checked,
    patents: document.getElementById('cb-patents').checked,
    pharma: document.getElementById('cb-pharma').checked,
    compatibility: document.getElementById('cb-compatibility').checked,
    clinical: document.getElementById('cb-clinical').checked,
  };
  if (!Object.values(selected).some(Boolean)) {
    alert('Vui lòng chọn ít nhất 1 mục để tra cứu!');
    return;
  }

  // ── Kiểm tra tên hoạt chất trước khi tìm kiếm ──
  const btnSearch = document.getElementById('btn-search');
  btnSearch.disabled = true;
  btnSearch.textContent = '🔍 Đang kiểm tra tên hoạt chất...';
  try {
    const validateData = await api('/api/validate-drug', { drugName });

    if (!validateData.valid && validateData.suggestions && validateData.suggestions.length > 0) {
      btnSearch.disabled = false;
      btnSearch.textContent = '🔬 Bắt đầu nghiên cứu';
      // Hiển thị modal gợi ý
      const picked = await showDrugSuggestionModal(drugName, validateData.suggestions);
      if (picked === null) return; // User nhấn Hủy
      if (picked !== drugName) {
        document.getElementById('drug-name').value = picked;
        startSearch(); // Gọi lại với tên đã sửa
        return;
      }
      // Nếu user chọn "Tiếp tục với tên gốc", tiếp tục bình thường
    } else if (!validateData.valid && (!validateData.suggestions || validateData.suggestions.length === 0)) {
      // Không tìm thấy và cũng không có gợi ý
      btnSearch.disabled = false;
      btnSearch.textContent = '🔬 Bắt đầu nghiên cứu';
      const continueAnyway = await showConfirmModal(
        'Không tìm thấy hoạt chất',
        `Không tìm thấy "${drugName}" trên cơ sở dữ liệu PubChem/ChEMBL.\nCó thể bạn đã nhập sai tên, hoặc đây là hoạt chất dạng enzyme/protein không có trong 2 cơ sở dữ liệu này.\n\nBạn có muốn tiếp tục tìm kiếm không?`,
        'Tiếp tục tìm kiếm', 'Hủy'
      );
      if (!continueAnyway) {
        btnSearch.disabled = false;
        btnSearch.textContent = '🔬 Bắt đầu nghiên cứu';
        return;
      }
    }
  } catch (e) {
    console.warn('Drug validation skipped:', e.message);
  }
  btnSearch.disabled = false;
  btnSearch.textContent = '🔬 Bắt đầu nghiên cứu';

  const searchId = 'search_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

  // Lưu API keys vào localStorage để không cần nhập lại
  localStorage.setItem('openai_api_key', openaiKey);
  localStorage.setItem('serper_api_key', serperKey);

  // Reset state từ kết quả tìm kiếm trước đó
  Object.assign(state, { 
    drugName, 
    dosageForm, 
    openaiKey, 
    serperKey,
    pubchemData: null,
    aiAnalysis: null,
    stabilityData: null,
    sraData: null,
    patentData: null,
    pharmaData: null,
    compatibilityData: null,
    clinicalData: null,
  });
  clearProtocolItems();
  // Xoá badge double-check của lượt trước (không để dính sang hoạt chất mới).
  document.querySelectorAll('.dc-result').forEach((el) => { el.innerHTML = ''; });

  // Reset UI và ẩn các card kết quả từ lượt tìm kiếm trước
  hide('empty-state');
  hide('results-section');
  show('loading-section');
  document.getElementById('loading-section').classList.add('active');
  document.getElementById('btn-search').disabled = true;

  // Ẩn các card điều kiện bên trong tab
  hide('stability-sources-card');
  hide('sra-insights-card');
  hide('patent-insights-card');
  setInner('sra-count', '');
  setInner('patent-count', '');

  renderProgressSteps(selected);
  startProgressPolling(searchId);

  // Đặt trạng thái đang tải chứa thanh tiến độ động cho các tab chưa có dữ liệu
  const tabLoadingHtml = (id, label) => `
    <div class="empty-state" style="padding: 4rem 2rem; max-width: 450px; margin: 0 auto;">
      <div class="empty-state-icon" style="font-size: 2.2rem; margin-bottom: 0.8rem;">⏳</div>
      <div class="empty-state-title" style="margin-bottom: 0.5rem; font-size: 0.95rem;">${label}</div>
      <div class="progress-bar-container" style="height: 5px; background: rgba(15,23,42,0.06); border-radius: 10px; overflow: hidden; margin-bottom: 0.5rem;">
        <div class="progress-bar-fill" id="${id}-tab-bar" style="width: 0%; height: 100%; background: var(--blue); transition: width 0.3s ease;"></div>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 0.72rem; color: var(--text-3); font-style: italic;">
        <span id="${id}-tab-detail">Đang xếp hàng...</span>
        <span id="${id}-tab-percent" style="font-weight: 600; color: var(--blue);">0%</span>
      </div>
    </div>
  `;
  const skippedHtml = () => `
    <div class="empty-state" style="padding:2rem">
      <div class="empty-state-icon">⏭️</div>
      <div class="empty-state-sub">Mục này không được chọn để tra cứu. Tick chọn lại ở khung tìm kiếm nếu muốn xem.</div>
    </div>
  `;

  const drugTabSkeletonHtml = `<div class="skeleton-lines">
    <div class="skeleton" style="height:13px;width:35%;"></div>
    <div class="skeleton" style="height:13px;width:88%;"></div>
    <div class="skeleton" style="height:13px;width:72%;"></div>
    <div class="skeleton" style="height:13px;width:60%;"></div>
  </div>`;
  if (selected.drug) {
    setInner('sec-structure', drugTabSkeletonHtml);
    setInner('sec-physical', drugTabSkeletonHtml);
    setInner('sec-chemical', drugTabSkeletonHtml);
    setInner('sec-biological', drugTabSkeletonHtml);
  } else {
    setInner('sec-structure', skippedHtml());
    setInner('sec-physical', skippedHtml());
    setInner('sec-chemical', skippedHtml());
    setInner('sec-biological', skippedHtml());
  }

  if (selected.stability) setInner('sec-stability', tabLoadingHtml('step-stability', 'Đang phân tích độ ổn định và lão hóa cấp tốc...'));
  else setInner('sec-stability', skippedHtml());

  if (selected.sra) setInner('sec-sra-products', tabLoadingHtml('step-sra', 'Đang đề xuất công thức nghiên cứu...'));
  else setInner('sec-sra-products', skippedHtml());

  if (selected.patents) setInner('sec-patents', tabLoadingHtml('step-patents', 'Đang tìm kiếm patent Google Patents...'));
  else setInner('sec-patents', skippedHtml());

  if (selected.pharma) setInner('sec-pharma-list', tabLoadingHtml('step-pharma', 'Đang tra cứu dược điển quốc tế...'));
  else setInner('sec-pharma-list', skippedHtml());

  if (selected.compatibility) setInner('sec-compatibility-results', tabLoadingHtml('step-compatibility', 'Đang phân tích tương tác tá dược trên PharmDE...'));
  else setInner('sec-compatibility-results', skippedHtml());

  if (selected.clinical) setInner('sec-clinical', tabLoadingHtml('step-clinical', 'Đang tra cứu thông tin dược lý & bào chế...'));
  else setInner('sec-clinical', skippedHtml());

  hide('pharma-standards-card');
  hide('pharma-equipment-card');
  hide('pharma-methods-card');
  setInner('pharma-count', '');

  const promises = [];

  // Nhóm PubChem/ChEMBL — cần chạy nếu chọn "Đặc điểm hoạt chất" HOẶC "Tương tác tá dược" (lấy SMILES)
  const needsPubchem = selected.drug || selected.compatibility;
  const pubchemPromise = needsPubchem ? (async () => {
    setStepStatus('step-pubchem', 'active');
    try {
      state.pubchemData = await api('/api/properties', { drugName, searchId });
      setStepStatus('step-pubchem', 'done', '');
    } catch (e) {
      setStepStatus('step-pubchem', 'error', e.message);
      state.pubchemData = null;
    }
  })() : Promise.resolve();
  if (needsPubchem) promises.push(pubchemPromise);

  // Group A: AI Analysis cho tab Đặc điểm hoạt chất (chỉ chạy nếu được chọn)
  if (selected.drug) {
    const runGroupA = async () => {
      await pubchemPromise;
      setStepStatus('step-ai', 'active');
      try {
        state.aiAnalysis = await api('/api/ai-analysis', {
          drugName, drugData: state.pubchemData, openaiKey, serperKey, searchId
        });
        setStepStatus('step-ai', 'done');
      } catch (e) {
        setStepStatus('step-ai', 'error', e.message);
        state.aiAnalysis = null;
      }

      // Render drug tab sớm để user đọc trong khi chờ các phần khác
      renderDrugTab();
      hide('loading-section');
      show('results-section');
    };
    promises.push(runGroupA());
  } else {
    // Không chọn "Đặc điểm hoạt chất" — không có gì để chờ hiển thị trước, mở kết quả ngay.
    hide('loading-section');
    show('results-section');
  }

  // Thread B: Forced Degradation
  if (selected.stability) {
    const runStability = async () => {
      setStepStatus('step-stability', 'active');
      try {
        state.stabilityData = await api('/api/forced-degradation', { drugName, openaiKey, serperKey, searchId });
        const mode = state.stabilityData.mode === 'web-search' ? 'Web search' : 'AI knowledge';
        setStepStatus('step-stability', 'done', mode);
        renderStabilityTab();
      } catch (e) {
        setStepStatus('step-stability', 'error', e.message);
        renderStabilityError(e.message);
      }
    };
    promises.push(runStability());
  }

  // Thread C: Vidal Formulas
  if (selected.sra) {
    const runSRA = async () => {
      setStepStatus('step-sra', 'active');
      try {
        state.sraData = await api('/api/sra-formulas', { drugName, dosageForm, openaiKey, searchId });
        setStepStatus('step-sra', 'done', `${state.sraData.totalProducts || (state.sraData.products || []).length} sản phẩm`);
        renderSRATab();
      } catch (e) {
        setStepStatus('step-sra', 'error', e.message);
        renderSRAError(e.message);
      }
    };
    promises.push(runSRA());
  }

  // Thread D: Patents
  if (selected.patents) {
    const runPatents = async () => {
      setStepStatus('step-patents', 'active');
      try {
        state.patentData = await api('/api/patents', { drugName, dosageForm, openaiKey, serperKey, searchId });
        // Danh sách patent thật nằm ở otherPatents/rawLinks (patents[] chỉ dùng cho bản đọc sâu cũ),
        // nên phải đếm cả hai — nếu chỉ đếm patents[] sẽ luôn hiển thị "0 patent" gây hiểu nhầm.
        const pd = state.patentData;
        const patentCount = (pd.patents || []).length
          + new Set([...(pd.otherPatents || []), ...(pd.rawLinks || [])].map((p) => p && p.url).filter(Boolean)).size;
        setStepStatus('step-patents', 'done', patentCount > 0
          ? `${patentCount} patent${pd.bothCount ? ` (${pd.bothCount} khớp dạng bào chế)` : ''}`
          : 'Chưa lấy được — có thể bị chặn, thử lại sau');
        renderPatentsTab();
      } catch (e) {
        setStepStatus('step-patents', 'error', e.message);
        renderPatentsError(e.message === 'HTTP 400' ? 'Bạn cần cung cấp Serper.dev API key trong file .env hoặc điền ở góc trên cùng.' : e.message);
      }
    };
    promises.push(runPatents());
  }

  // Thread E: Pharmacopoeia Search
  if (selected.pharma) {
    const runPharma = async () => {
      setStepStatus('step-pharma', 'active');
      try {
        state.pharmaData = await api('/api/pharmacopoeia/search', { drugName, searchId });
        const total = state.pharmaData.total || 0;
        setStepStatus('step-pharma', 'done', `${total} monograph`);
        renderPharmaTab();
      } catch (e) {
        setStepStatus('step-pharma', 'error', e.message);
        setInner('sec-pharma-list', errorBox(e.message));
      }
    };
    promises.push(runPharma());
  }

  // Thread F: Compatibility (PharmDE) — chờ PubChem hoàn thành để lấy SMILES
  if (selected.compatibility) {
    const runCompatibility = async () => {
      await pubchemPromise;
      setStepStatus('step-compatibility', 'active');
      try {
        let smiles = '';
        if (state.pubchemData) {
          // Ưu tiên lấy SMILES từ nhiều nguồn
          smiles = (state.pubchemData.properties && state.pubchemData.properties.CanonicalSMILES)
            || state.pubchemData.smiles
            || '';
        }
        state.compatibilityData = await api('/api/compatibility', { drugName, smiles, searchId });
        setStepStatus('step-compatibility', 'done', `Đã tìm thấy ${state.compatibilityData.total || 0} tương tác`);
        renderCompatibilityTab();
      } catch (e) {
        setStepStatus('step-compatibility', 'error', e.message);
        renderCompatibilityError(e.message);
      }
    };
    promises.push(runCompatibility());
  }

  // Thread G: Thông tin dược lý & bào chế (DeepSeek :online + trích dẫn nguồn)
  if (selected.clinical) {
    const runClinical = async () => {
      setStepStatus('step-clinical', 'active');
      try {
        state.clinicalData = await api('/api/clinical-info', { drugName, dosageForm, openaiKey, searchId });
        setStepStatus('step-clinical', 'done', `${(state.clinicalData.sources || []).length} nguồn`);
        renderClinicalTab();
      } catch (e) {
        setStepStatus('step-clinical', 'error', e.message);
        renderClinicalError(e.message);
      }
    };
    promises.push(runClinical());
  }

  try {
    await Promise.all(promises);
  } catch (e) {
    console.error('Parallel execution error', e);
  } finally {
    stopProgressPolling();
    document.getElementById('btn-search').disabled = false;
    document.getElementById('loading-section').classList.remove('active');
    hide('loading-section');
    show('results-section');

    // Lưu lịch sử tra cứu (best-effort, không chặn UI nếu lỗi)
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        await supabase.from('search_history').insert({
          user_id: session.user.id,
          drug_name: state.drugName,
          dosage_form: state.dosageForm,
          data: {
            pubchemData: state.pubchemData,
            aiAnalysis: state.aiAnalysis,
            stabilityData: state.stabilityData,
            sraData: state.sraData,
            patentData: state.patentData,
            pharmaData: state.pharmaData,
            compatibilityData: state.compatibilityData,
            clinicalData: state.clinicalData,
          },
        });
      }
    } catch (histErr) {
      console.error('Không thể lưu lịch sử:', histErr);
    }
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
            ${pc.synonyms.slice(0, 15).map((s) => `<span class="tag tag-cyan" style="font-size:.75rem;padding: 4px 10px;border-radius: 100px;background: rgba(34,211,238,0.1);border: 1px solid rgba(34,211,238,0.25);color: #0e7490;font-weight: 500;">${escHtml(s)}</span>`).join('')}
          </div>
        </div>` : ''}
      </div>
    `;
  } else {
    structureHtml = errorBox('Không tìm thấy dữ liệu. Kiểm tra lại tên hoạt chất (ưu tiên tên INN tiếng Anh).');
  }

  if (pc) {
    const structPairs = [
      ['Tên IUPAC', p.IUPACName],
      ['Công thức phân tử', p.MolecularFormula],
      ['Khối lượng phân tử', p.MolecularWeight],
      ['SMILES', p.CanonicalSMILES || pc.smiles],
      ['InChIKey', p.InChIKey],
      ['Mã ChEMBL', pc.chemblId],
      ['Tên đồng nghĩa', (pc.synonyms || []).join('; ')],
    ];
    const structSrc = pc.sources?.chembl ? [{ url: pc.sources.chembl, title: `ChEMBL – ${pc.chemblId || state.drugName}` }] : undefined;
    structureHtml = pickBox('drug', 'drug.structure', 'Cấu trúc & định danh hoạt chất', blkKV(structPairs, structSrc)) + structureHtml;
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
      ? `<span class="tag" style="font-size:.6rem;padding:1px 6px;background:rgba(251,191,36,.15);color:#b45309;border:1px solid rgba(251,191,36,.3)">🟡 AI – cần kiểm tra</span>`
      : '';
    if (url && !url.startsWith('http')) {
      if (url.startsWith('10.')) url = 'https://doi.org/' + url;
      else url = 'https://' + url;
    }
    return `<a href="${escHtml(url)}" target="_blank" rel="noopener"
      style="display:inline-flex;align-items:center;gap:3px;font-size:.62rem;padding:1px 6px;border-radius:4px;
      background:rgba(34,197,94,.12);color:#15803d;border:1px solid rgba(34,197,94,.3);
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

  const rawPc = ai?._pubchemRawData || {};
  const pcUrl = ai?._pubchemUrl || '';

  function normalizeUrl(u) {
    if (!u) return null;
    if (u.startsWith('http')) return u;
    if (u.startsWith('10.')) return 'https://doi.org/' + u;
    return 'https://' + u;
  }
  function sourceCell(url, sourceName) {
    if (!url) return `<span class="tag" style="font-size:.6rem;padding:1px 6px;background:rgba(251,191,36,.15);color:#b45309;border:1px solid rgba(251,191,36,.3)">🟡 AI – cần kiểm tra</span>`;
    const nurl = normalizeUrl(url);
    return `<a href="${escHtml(nurl)}" target="_blank" rel="noopener"
      style="display:inline-flex;align-items:center;gap:3px;font-size:.62rem;padding:1px 6px;border-radius:4px;
      background:rgba(34,197,94,.12);color:#15803d;border:1px solid rgba(34,197,94,.3);
      text-decoration:none;white-space:nowrap" title="${escHtml(nurl)}">🟢 ${escHtml(sourceName || 'Xác minh')} →</a>`;
  }

  // Gộp TOÀN BỘ giá trị tìm được (PubChem raw + AI) vào 1 bảng duy nhất,
  // đúng thứ tự: Cảm quan → Độ tan → Nhiệt độ nóng chảy → Khả năng hút ẩm.
  // Không giới hạn chỉ 1 giá trị/chỉ tiêu — liệt kê hết các giá trị tìm được.
  const physicalRows = [];
  (rawPc.description || []).forEach(item => physicalRows.push({ label: 'Cảm quan', value: item.value, url: item.sourceUrl, sourceName: 'PubChem' }));
  (rawPc.color || []).forEach(item => physicalRows.push({ label: 'Cảm quan', value: item.value, url: item.sourceUrl, sourceName: 'PubChem' }));
  if (ai?.physical && val(ai.physical.appearance)) {
    physicalRows.push({ label: 'Cảm quan', value: val(ai.physical.appearance), url: typeof ai.physical.appearance === 'object' ? ai.physical.appearance.sourceUrl : null, sourceName: 'Xác minh' });
  }
  (rawPc.solubility || []).forEach(item => physicalRows.push({ label: 'Độ tan', value: item.value, url: item.sourceUrl, sourceName: 'PubChem' }));
  if (ai?.physical) {
    const sol = ai.physical.solubilityAnalysis || ai.physical.solubility;
    if (val(sol)) physicalRows.push({ label: 'Độ tan', value: val(sol), url: typeof sol === 'object' ? sol.sourceUrl : null, sourceName: 'Xác minh' });
  }
  (rawPc.meltingPoint || []).forEach(item => physicalRows.push({ label: 'Nhiệt độ nóng chảy', value: item.value, url: item.sourceUrl, sourceName: 'PubChem' }));
  if (ai?.physical && val(ai.physical.meltingPoint)) {
    physicalRows.push({ label: 'Nhiệt độ nóng chảy', value: val(ai.physical.meltingPoint), url: typeof ai.physical.meltingPoint === 'object' ? ai.physical.meltingPoint.sourceUrl : null, sourceName: 'Xác minh' });
  }
  if (ai?.physical && val(ai.physical.hygroscopicity)) {
    physicalRows.push({ label: 'Khả năng hút ẩm', value: val(ai.physical.hygroscopicity), url: typeof ai.physical.hygroscopicity === 'object' ? ai.physical.hygroscopicity.sourceUrl : null, sourceName: 'Xác minh' });
  }

  if (physicalRows.length) {
    // Nhóm theo "label" (giữ nguyên thứ tự xuất hiện) và dùng rowspan để tên chỉ tiêu
    // (Cảm quan, Độ tan...) chỉ hiện 1 lần dù có nhiều dòng giá trị bên dưới.
    const groups = [];
    for (const r of physicalRows) {
      let g = groups.find(g => g.label === r.label);
      if (!g) { g = { label: r.label, rows: [] }; groups.push(g); }
      g.rows.push(r);
    }
    const bodyHtml = groups.map(g => g.rows.map((r, i) => `<tr>
      ${i === 0 ? `<td rowspan="${g.rows.length}"><strong>${escHtml(g.label)}</strong></td>` : ''}
      <td>${linkify(r.value)}</td>
      <td>${sourceCell(r.url, r.sourceName)}</td>
    </tr>`).join('')).join('');
    physHtml += `<div class="data-table-wrap">
      <table class="data-table">
        <thead><tr><th>Chỉ tiêu</th><th>Giá trị</th><th>Nguồn</th></tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
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
        <div class="insight-label" style="color:#b45309; margin-bottom:8px;">🔷 Dạng thù hình tinh thể (Polymorphism)</div>
        <p style="line-height:1.75; font-size:0.9rem;">${escHtml(poly.overview)}</p>`;
        
      if (poly.forms && Array.isArray(poly.forms)) {
        physHtml += `<div style="display:flex; flex-direction:column; gap:8px; margin-top:12px;">`;
        for (const f of poly.forms) {
          physHtml += `<div style="background:rgba(15,23,42,0.05); padding:8px 12px; border-radius:6px; border-left:3px solid #b45309;">
            <div style="font-weight:600; color:#b45309; margin-bottom:4px; font-size:0.9rem;">${escHtml(f.name)}</div>
            ${f.characteristics ? `<div style="font-size:0.85rem; margin-bottom:4px;"><span style="color:#64748b;">Đặc điểm:</span> ${escHtml(f.characteristics)}</div>` : ''}
            ${f.differences ? `<div style="font-size:0.85rem;"><span style="color:#64748b;">Khác biệt:</span> ${escHtml(f.differences)}</div>` : ''}
          </div>`;
        }
        physHtml += `</div>`;
      }
      
      if (poly.commercialForm) {
        physHtml += `<div class="mt-2" style="font-size:0.85rem; background:rgba(34,197,94,0.1); border:1px solid rgba(34,197,94,0.2); padding:8px; border-radius:6px; color:#15803d;">
          <strong>✅ Dạng thương mại:</strong> ${escHtml(poly.commercialForm)}
        </div>`;
      }
      
      if (poly.morphology) {
        physHtml += `<div class="mt-2" style="font-size:0.85rem; background:rgba(251,191,36,0.1); border:1px solid rgba(251,191,36,0.2); padding:8px; border-radius:6px; color:#b45309;">
          <strong>🔬 Hình dạng tiểu phân:</strong> ${escHtml(poly.morphology)}
        </div>`;
      }
      
      const polyImages = (Array.isArray(poly.images) && poly.images.length) ? poly.images : (poly.imageUrl ? [poly.imageUrl] : []);
      if (polyImages.length) {
        physHtml += `<div class="mt-2" style="display:flex; gap:8px; flex-wrap:wrap; justify-content:center;">
          ${polyImages.map(src => `<img src="${escHtml(src)}" alt="Crystal morphology" style="max-width:calc(33% - 6px); max-height:180px; border-radius:6px; border:1px solid rgba(15,23,42,0.1); object-fit:contain; background:#f1f5f9; padding:4px;" onerror="this.style.display='none'">`).join('')}
        </div>`;
      }

      // Danh sách nguồn — ưu tiên mảng "sources" (nhiều nguồn thật, từ DeepSeek đọc kỹ),
      // nếu không có thì dùng srcUrl/paperTitle đơn lẻ (dữ liệu cũ) làm nguồn duy nhất.
      const polySources = (Array.isArray(poly.sources) && poly.sources.length)
        ? poly.sources
        : (srcUrl || paperTitle) ? [{ url: srcUrl, title: paperTitle }] : [];

      if (polySources.length) {
        physHtml += `<div class="mt-2" style="display:flex; flex-direction:column; gap:6px;">
          <div style="font-size:0.72rem; color:#64748b; font-weight:600;">📄 Nguồn tham khảo (${polySources.length}):</div>
          ${polySources.map(s => {
            const u = normalizeUrl(s.url);
            return u
              ? `<a href="${escHtml(u)}" target="_blank" rel="noopener"
                  style="display:flex; align-items:center; gap:6px; font-size:.75rem; padding:5px 10px; border-radius:5px;
                  background:rgba(251,191,36,.1); color:#92400e; border:1px solid rgba(251,191,36,.3); text-decoration:none; word-break:break-all;">
                  🔗 ${escHtml(s.title || u)}</a>`
              : `<span style="font-size:.72rem; color:var(--text-3);">⚠️ ${escHtml(s.title || 'Chưa có URL xác minh')}</span>`;
          }).join('')}
        </div>`;
      }

      physHtml += `</div>`;
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
          <div class="insight-label" style="color:#b45309">🔷 Dạng thù hình tinh thể (Polymorphism)</div>
          <p style="line-height:1.75">${linkify(polymorphVal)}</p>
          ${paperTitle ? `<p class="mt-1 text-sm" style="color:var(--text-3)">📄 Tài liệu: ${escHtml(paperTitle)}</p>` : ''}
          ${srcUrl
            ? `<a href="${escHtml(srcUrl)}" target="_blank" rel="noopener"
                style="display:inline-flex;align-items:center;gap:4px;font-size:.7rem;margin-top:6px;padding:3px 10px;border-radius:5px;
                background:rgba(251,191,36,.15);color:#b45309;border:1px solid rgba(251,191,36,.3);text-decoration:none">
                🔗 Xem nguồn tài liệu →</a>`
            : `<span style="font-size:.68rem;color:var(--text-3)">⚠️ Chưa có DOI xác minh</span>`}
        </div>`;
      }
    }

  }

  if (physHtml) {
    const physPairs = physicalRows.map((r) => [r.label, r.value]);
    let physSrc;
    const polyObj = ai?.physical?.polymorphs;
    if (polyObj && typeof polyObj === 'object' && polyObj.overview) {
      physPairs.push(['Dạng thù hình (Polymorphism)', polyObj.overview]);
      if (polyObj.commercialForm) physPairs.push(['Dạng thương mại', polyObj.commercialForm]);
      if (polyObj.morphology) physPairs.push(['Hình dạng tiểu phân', polyObj.morphology]);
      if (Array.isArray(polyObj.sources) && polyObj.sources.length) physSrc = polyObj.sources;
    }
    physHtml = pickBox('drug', 'drug.physical', 'Tính chất vật lý & dạng thù hình', blkKV(physPairs, physSrc)) + physHtml;
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
    exp.logD?.[0]    ? `LogD: <strong>${escHtml(exp.logD[0])}</strong>` : null,
  ].filter(Boolean);

  let chemHtml = chemNums.length
    ? `<p style="color:var(--text-2);font-size:.85rem;line-height:2;margin-bottom:.5rem">${chemNums.join(' &nbsp;·&nbsp; ')}</p>`
    : '';

  // PubChem pKa (xác minh)
  const pcPka = rawPc.pka || [];
  if (pcPka.length) {
    chemHtml += `<div class="insight-box mt-2" style="border-color:rgba(34,197,94,.3);background:rgba(34,197,94,.05)">
      <div class="insight-label" style="color:#15803d">✅ pKa từ PubChem CID ${escHtml(String(cid2 || ''))}</div>
      ${pcPka.map(item => `<p class="mt-1 text-sm" style="line-height:1.7">
        ${escHtml(item.value)}
        <a href="${escHtml(item.sourceUrl)}" target="_blank" rel="noopener"
          style="display:inline-flex;align-items:center;gap:3px;font-size:.62rem;padding:1px 6px;border-radius:4px;
          background:rgba(34,197,94,.12);color:#15803d;border:1px solid rgba(34,197,94,.3);
          text-decoration:none;margin-left:4px">🟢 Xác minh →</a>
      </p>`).join('')}
    </div>`;
  }

  if (ai?.chemical) {
    chemHtml += `<div class="insight-box purple mt-2">
      <div class="insight-label purple">🤖 AI Phân tích tính chất hóa học</div>
      ${!pcPka.length ? row('pKa', aiPkaField || ai.chemical.pkaValues) : ''}
      ${row('Tính acid/base', ai.chemical.acidBaseNature)}
    </div>`;
  }

  if (chemHtml) {
    const chemPairs = [];
    if (pcPka.length) chemPairs.push(['pKa (PubChem)', pcPka.map((x) => x.value).join('; ')]);
    else if (val(aiPkaField || ai?.chemical?.pkaValues)) chemPairs.push(['pKa', val(aiPkaField || ai?.chemical?.pkaValues)]);
    if (ai?.chemical && val(ai.chemical.acidBaseNature)) chemPairs.push(['Tính acid/base', val(ai.chemical.acidBaseNature)]);
    if (exp.logD?.[0]) chemPairs.push(['LogD', exp.logD[0]]);
    if (chemPairs.length) chemHtml = pickBox('drug', 'drug.chemical', 'Tính chất hóa học', blkKV(chemPairs)) + chemHtml;
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
          color:#15803d;border:1px solid rgba(34,197,94,.3);text-decoration:none;margin-left:6px">🟢 ChEMBL →</a>
      </div>
      <div class="tag-cloud">${state.drugData.mechanisms.map((m) =>
        `<span class="tag tag-green">${escHtml(m.mechanism_of_action || m.action_type)}</span>`).join('')}
      </div>
    </div>`;
  }

  if (bioHtml) {
    const bioPairs = [];
    if (ai?.biological && val(ai.biological.logP)) bioPairs.push(['LogP', val(ai.biological.logP)]);
    if (ai?.biological && val(ai.biological.bcsClass)) bioPairs.push(['Phân loại BCS', val(ai.biological.bcsClass)]);
    if (state.drugData?.mechanisms?.length) bioPairs.push(['Cơ chế tác dụng (ChEMBL)', state.drugData.mechanisms.map((m) => m.mechanism_of_action || m.action_type).filter(Boolean).join('; ')]);
    if (bioPairs.length) bioHtml = pickBox('drug', 'drug.biological', 'Tính chất sinh học', blkKV(bioPairs)) + bioHtml;
  }
  setInner('sec-biological', bioHtml);
}


// ── Render: Stability Tab ─────────────────────────────────────────────────────

function paperSummaryControlsHtml(id, url, title) {
  // Dùng JSON.stringify + escHtml để truyền an toàn qua thuộc tính onclick="" (tránh vỡ chuỗi
  // khi title/url chứa dấu nháy đơn/kép).
  const argsJson = escHtml(JSON.stringify([id, url, title || '']));
  return `
    <div style="margin-top:8px;">
      <button id="paper-sum-btn-${id}" class="tag tag-blue" style="font-size:.7rem; cursor:pointer; border:none;"
        onclick="summarizePaperClick.apply(null, ${argsJson})">🔎 DeepSeek đọc & tóm tắt bài này</button>
      <div id="paper-sum-result-${id}" style="margin-top:6px;"></div>
    </div>
  `;
}

async function summarizePaperClick(id, url, title) {
  const btn = document.getElementById(`paper-sum-btn-${id}`);
  const resultEl = document.getElementById(`paper-sum-result-${id}`);
  if (!btn || !resultEl) return;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '⏳ DeepSeek đang đọc bài báo...';
  resultEl.innerHTML = '';
  try {
    const data = await api('/api/summarize-paper', { url, title, drugName: state.drugName, openaiKey: state.openaiKey });
    const warnHtml = data.fetchFailed
      ? `<div style="font-size:.7rem; color:#b45309; margin-bottom:6px;">⚠️ Không tải trực tiếp được trang này (có thể bị chặn truy cập tự động) — AI đã thử tìm lại qua web search.</div>`
      : '';
    const pick = pickBox('stability', 'stability.paper.' + id, 'Tóm tắt bài báo: ' + (title || url),
      Object.assign(blkText(data.summary), { sources: [{ url, title: title || url }] }));
    resultEl.innerHTML = `<div style="font-size:.8rem; line-height:1.8; padding:10px 12px; background:rgba(37,99,235,0.06); border:1px solid rgba(37,99,235,0.2); border-radius:6px; color:var(--text-1);">${pick}${warnHtml}<div style="white-space:pre-line;">${linkify(data.summary)}</div></div>`;
    updateProtocolCount();
    btn.style.display = 'none';
  } catch (e) {
    resultEl.innerHTML = `<div style="font-size:.75rem; color:var(--red);">Lỗi: ${escHtml(e.message)}</div>`;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

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
    'web-search':       '🌐 Web Search',
    'google-search':    '🌐 Web Search',
    'ai-knowledge':     '🤖 AI Knowledge',
  }[d.searchMode || d.mode || 'ai-knowledge'] || '🤖 AI Knowledge';

  let html = `<div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.8rem">
    <span class="tag tag-cyan" style="font-size:.72rem">${modeLabel}</span>
    ${(d.rawPapers?.length || 0) > 0 ? `<a href="#reference-list-section" class="tag tag-blue" style="font-size:.72rem; text-decoration: none; cursor: pointer; transition: opacity 0.2s;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">📄 ${d.rawPapers.length} bài báo tìm được (Click để xem) ⬇️</a>` : ''}
  </div>`;

  if (d.overview) {
    html += `<div class="insight-box amber" style="margin-bottom:1rem">
      ${pickBox('stability', 'stability.overview', 'Tổng quan độ ổn định', blkText(d.overview))}
      <div class="insight-label amber">📋 Tổng quan từ bài báo</div>
      <p>${escHtml(d.overview)}</p>
    </div>`;
  }

  if (d.stablePhRange) {
    html += `<div class="insight-box purple" style="margin-bottom:1.5rem">
      ${pickBox('stability', 'stability.phRange', 'Dải pH ổn định', blkKV([['Dải pH', d.stablePhRange.range], ['Chi tiết', d.stablePhRange.details], ['Nguồn', d.stablePhRange.reference]]))}
      <div class="insight-label purple">🧪 Dải pH ổn định</div>
      <div style="margin-bottom:6px"><strong>Dải pH:</strong> <span class="tag tag-purple">${escHtml(d.stablePhRange.range)}</span></div>
      <p style="white-space: pre-line; line-height: 1.6; font-size: 0.9rem;">${escHtml(d.stablePhRange.details)}</p>
      ${d.stablePhRange.reference ? `<div style="margin-top:8px; border-top:1px solid rgba(168,85,247,.2); padding-top:6px;"><span class="stability-row-label" style="color:#7e22ce">📎 Nguồn:</span> <span class="stability-row-val" style="font-size:.75rem;color:#6b21a8">${renderRef(d.stablePhRange.reference)}</span></div>` : ''}
      ${d.stablePhRange.quote ? `<div style="margin-top:6px; background:rgba(15,23,42,0.03); border-radius:4px; padding:6px; font-style:italic; border-left: 2px solid rgba(168,85,247,.4)"><span style="font-size:.75rem;color:#7e22ce">" ${escHtml(d.stablePhRange.quote)} "</span></div>` : ''}
    </div>`;
  }

  html += '<div class="stability-grid">';
  for (const c of conditions) {
    const data = d[c.key];
    if (!data) continue;
    const condBlock = blkKV([
      ['Điều kiện', data.conditions], ['Mức phân hủy', data.rate], ['Sản phẩm phân hủy', data.products],
      ['Cơ chế', data.mechanism], ['Nguồn', data.reference],
    ]);
    if (data.quote) condBlock.pairs.push(['Trích dẫn', '“' + toText(data.quote) + '”']);
    html += `
      <div class="stability-item">
        ${pickBox('stability', 'stability.' + c.key, 'Phân hủy trong điều kiện: ' + c.name, condBlock)}
        <div class="stability-header">
          <div class="section-icon ${c.color}" style="width:28px;height:28px;font-size:.85rem">${c.icon}</div>
          <div class="stability-name">${escHtml(c.name)}</div>
        </div>
        ${data.conditions ? `<div class="stability-row"><span class="stability-row-label">Điều kiện:</span><span class="stability-row-val">${linkify(data.conditions)}</span></div>` : ''}
        ${data.rate       ? `<div class="stability-row"><span class="stability-row-label">Mức phân hủy:</span><span class="stability-row-val">${escHtml(data.rate)}</span></div>` : ''}
        ${data.products   ? `<div class="stability-row"><span class="stability-row-label">SP phân hủy:</span><span class="stability-row-val">${escHtml(data.products)}</span></div>` : ''}
        ${data.mechanism  ? `<div class="stability-row"><span class="stability-row-label">Cơ chế:</span><span class="stability-row-val">${escHtml(data.mechanism)}</span></div>` : ''}
        ${data.reference  ? `<div class="stability-row" style="border-top:1px solid rgba(99,102,241,.15);margin-top:6px;padding-top:6px">
          <span class="stability-row-label" style="color:#4338ca">📎 Nguồn:</span>
          <span class="stability-row-val" style="font-size:.73rem;color:#4338ca;line-height:1.6">
            ${escHtml(data.reference)}
          </span>
        </div>` : ''}
        ${data.quote      ? `<div style="margin-top:6px; background:rgba(15,23,42,0.02); border-radius:4px; padding:6px; font-style:italic; border-left: 2px solid rgba(99,102,241,.3)">
          <span style="font-size:.73rem;color:#475569;line-height:1.5">" ${escHtml(data.quote)} "</span>
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
    html += `<div class="insight-box mt-2">${pickBox('stability', 'stability.analyticMethod', 'Phương pháp phân tích (độ ổn định)', blkText(d.analyticMethod))}<div class="insight-label">🔬 Phương pháp phân tích</div><p>${escHtml(d.analyticMethod)}</p></div>`;
  }

  if (d.conclusion) {
    html += `<div class="insight-box green mt-2">${pickBox('stability', 'stability.conclusion', 'Kết luận độ ổn định', blkText(d.conclusion))}<div class="insight-label green">✅ Kết luận</div><p>${escHtml(d.conclusion)}</p></div>`;
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
        <div class="data-item-label" style="margin-bottom:10px; color: #2563eb;">📄 Các bài báo được AI sử dụng làm Trích dẫn (${readPapers.length})</div>
        <div class="source-links">
          ${readPapers.map((p, i) => `
            <div class="source-link-item" style="margin-bottom: 12px; padding: 10px; background: rgba(15,23,42,0.03); border-radius: 6px; border-left: 3px solid #3b82f6;">
              <div style="font-weight: 600; color: #0f172a; font-size: 0.85rem; margin-bottom: 4px;">
                <span style="color: #2563eb;">[${i + 1}]</span>
                ${p.url
                  ? `<a href="${escHtml(p.url)}" target="_blank" rel="noopener" style="color: #0f172a; text-decoration: none;">${escHtml(p.title || 'Xem bài báo')}</a>`
                  : `<span>${escHtml(p.title || '')}</span>`
                }
              </div>
              ${p.url ? `<div style="font-size: 0.75rem; color: #475569; word-break: break-all;">
                <span style="color: #4338ca; font-weight: 500;">🔗 URL:</span>
                <a href="${escHtml(p.url)}" target="_blank" rel="noopener" style="color: #475569; text-decoration: underline;">${escHtml(p.url)}</a>
              </div>` : ''}
              ${p.doi ? `<div style="font-size: 0.75rem; color: #475569; word-break: break-all; margin-top: 2px;">
                <span style="color: #10b981; font-weight: 500;">📌 DOI:</span>
                <a href="https://doi.org/${escHtml(p.doi)}" target="_blank" rel="noopener" style="color: #475569; text-decoration: underline;">${escHtml(p.doi)}</a>
              </div>` : ''}
              ${p.url ? paperSummaryControlsHtml(`r${i}`, p.url, p.title) : ''}
            </div>`).join('')}
        </div>
      </div>`;
    }

    if (unreadPapers.length) {
      html += `<div class="mt-2" style="margin-bottom: 20px;">
        <div class="data-item-label" style="margin-bottom:10px; color: #b45309;">📚 Recommend đọc thêm (Các bài báo AI đã quét nhưng không sử dụng) (${unreadPapers.length})</div>
        <div class="source-links">
          ${unreadPapers.map((p, i) => `
            <div class="source-link-item" style="margin-bottom: 12px; padding: 10px; background: rgba(180,83,9,0.06); border-radius: 6px; border-left: 3px solid #b45309; opacity: 0.8;">
              <div style="font-weight: 600; color: #b45309; font-size: 0.85rem; margin-bottom: 4px;">
                <span style="color: #b45309;">[${i + 1}]</span>
                ${p.url
                  ? `<a href="${escHtml(p.url)}" target="_blank" rel="noopener" style="color: #b45309; text-decoration: none;">${escHtml(p.title || 'Xem bài báo')}</a>`
                  : `<span>${escHtml(p.title || '')}</span>`
                }
              </div>
              ${p.url ? `<div style="font-size: 0.75rem; color: #475569; word-break: break-all;">
                <span style="color: #b45309; font-weight: 500;">🔗 URL:</span>
                <a href="${escHtml(p.url)}" target="_blank" rel="noopener" style="color: #475569; text-decoration: underline;">${escHtml(p.url)}</a>
              </div>` : ''}
              ${p.doi ? `<div style="font-size: 0.75rem; color: #475569; word-break: break-all; margin-top: 2px;">
                <span style="color: #10b981; font-weight: 500;">📌 DOI:</span>
                <a href="https://doi.org/${escHtml(p.doi)}" target="_blank" rel="noopener" style="color: #475569; text-decoration: underline;">${escHtml(p.doi)}</a>
              </div>` : ''}
              ${p.url ? paperSummaryControlsHtml(`u${i}`, p.url, p.title) : ''}
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

// Bảng quy trình pha chế từng bước: STT | Trình tự | Thông số kiểm soát
function processTableHtml(steps) {
  if (!Array.isArray(steps) || !steps.length) return '';
  const th = 'padding:8px 10px;text-align:left;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--text-3);border:1px solid rgba(15,23,42,.1);background:rgba(15,23,42,.03)';
  const td = 'padding:8px 10px;border:1px solid rgba(15,23,42,.08);vertical-align:top';
  return `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.82rem;margin-top:6px">
    <thead><tr>
      <th style="${th};width:44px;text-align:center">STT</th>
      <th style="${th}">Trình tự</th>
      <th style="${th};width:200px">Thông số kiểm soát</th>
    </tr></thead>
    <tbody>${steps.map((s, i) => `<tr>
      <td style="${td};text-align:center;font-weight:600;color:var(--text-3)">${i + 1}</td>
      <td style="${td};color:var(--text-2)">${escHtml(s.action || '')}</td>
      <td style="${td};color:var(--text-3)">${escHtml(s.control || '')}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

// Thẻ 1 công thức đề xuất: thành phần + hàm lượng + vai trò, kèm quy trình sản xuất từng bước.
function suggestedFormulaHtml(f, idx) {
  const naBlank = (v) => (!v || /^n\/a$/i.test(String(v).trim())) ? '' : v;
  const exHtml = (f.excipients || []).filter(e => e && typeof e === 'object').map((e) => `
    <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(15,23,42,0.02); border:1px solid rgba(15,23,42,0.05); padding:8px 12px; border-radius:6px; font-size:0.82rem; gap:12px;">
      <div style="font-weight:600; color:var(--text-2); flex:1; text-align:left;">${escHtml(e.name || '')}</div>
      <div style="color:var(--text-3); font-weight:500; font-size:0.8rem; width:90px; text-align:right; white-space:nowrap;">${escHtml(naBlank(e.amount))}</div>
      <div style="font-size:0.72rem; color:#6d28d9; font-weight:600; background:rgba(139,92,246,0.12); border:1px solid rgba(139,92,246,0.25); padding:2px 8px; border-radius:100px; text-align:center; min-width:110px; letter-spacing:0.02em; white-space:nowrap;">${escHtml(e.role || '')}</div>
    </div>`).join('');
  const exRows = (f.excipients || []).filter((e) => e && typeof e === 'object').map((e) => [e.name || '', naBlank(e.amount) || '', e.role || '']);
  const procLines = (arr) => (Array.isArray(arr) ? arr.map((s, i) => `${i + 1}. ${s.action || ''}${s.control ? ` (Kiểm soát: ${s.control})` : ''}`).join('\n') : '');
  const sfBlock = blkTable(['Tá dược', 'Hàm lượng', 'Vai trò'], exRows);
  let sfNote = '';
  if (procLines(f.process)) sfNote += 'Trình tự pha chế:\n' + procLines(f.process);
  if (procLines(f.coatingProcess)) sfNote += (sfNote ? '\n\n' : '') + 'Trình tự pha chế dịch bao phim:\n' + procLines(f.coatingProcess);
  if (sfNote) sfBlock.note = sfNote;
  return `
    <div class="product-card" style="display:block; margin-bottom:1rem;">
      ${pickBox('sra', 'sra.suggested.' + idx, `Công thức đề xuất ${idx + 1}${naBlank(f.productName) ? ' – ' + f.productName : ''}`, sfBlock)}
      <div class="product-name">🧪 Công thức đề xuất ${idx + 1}${naBlank(f.productName) ? ' — ' + escHtml(f.productName) : ''}</div>
      ${naBlank(f.activeIngredient) ? `<div class="stability-row"><span class="stability-row-label">Hoạt chất:</span><span class="stability-row-val">${escHtml(f.activeIngredient)}${naBlank(f.strength) ? ' — ' + escHtml(f.strength) : ''}</span></div>` : ''}
      ${naBlank(f.dosageForm) ? `<div class="stability-row"><span class="stability-row-label">Dạng bào chế:</span><span class="stability-row-val">${escHtml(f.dosageForm)}</span></div>` : ''}
      ${exHtml ? `<div style="margin-top:.6rem"><div class="data-item-label" style="margin-bottom:6px">Thành phần công thức (Tá dược & Vai trò):</div><div style="display:flex; flex-direction:column; gap:6px;">${exHtml}</div></div>` : ''}
      <div class="data-item-label" style="margin-top:.9rem;margin-bottom:2px">🔬 Trình tự pha chế:</div>
      ${processTableHtml(f.process) || '<p class="text-3 text-sm">Chưa dựng được quy trình.</p>'}
      ${(Array.isArray(f.coatingProcess) && f.coatingProcess.length) ? `<div class="data-item-label" style="margin-top:.9rem;margin-bottom:2px">🎨 Trình tự pha chế dịch bao phim:</div>${processTableHtml(f.coatingProcess)}` : ''}
    </div>`;
}

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

  // Coi "N/A"/rỗng là không có dữ liệu — để trống thay vì hiện chữ "N/A" gây rối mắt.
  const naBlank = (v) => (!v || /^n\/a$/i.test(String(v).trim())) ? '' : v;

  const productBlock = (pr) => {
    const src = pr.sourceUrl ? [{ url: pr.sourceUrl, title: pr.source || pr.productName || 'Nguồn công thức' }] : undefined;
    if (pr.excipients?.length && typeof pr.excipients[0] === 'object') {
      return blkTable(['Tá dược', 'Hàm lượng', 'Vai trò'], pr.excipients.map((e) => [e.name || '', naBlank(e.amount) || '', e.role || '']), src);
    }
    if (pr.excipients?.length) return blkList(pr.excipients, src);
    return blkKV([['Hoạt chất', pr.activeIngredient], ['Dạng bào chế', pr.dosageForm], ['Hàm lượng', pr.strength]], src);
  };
  const productsHtml = products.map((pr, prIdx) => `
    <div class="product-card">
      ${pickBox('sra', 'sra.product.' + prIdx, `Công thức tham khảo: ${pr.productName || 'Không rõ tên'}${naBlank(pr.manufacturer) ? ' – ' + pr.manufacturer : ''}`, productBlock(pr))}
      <div>
        <div class="product-name">${escHtml(pr.productName || 'Không rõ tên')}</div>
        ${pr.productNameEn ? `<div style="font-size:.78rem;color:var(--text-3);font-style:italic;margin-top:1px;">${escHtml(pr.productNameEn)}</div>` : ''}
        <div class="product-meta">
          ${naBlank(pr.manufacturer) ? `🏭 ${escHtml(pr.manufacturer)}` : ''}
          ${naBlank(pr.country) ? ` &nbsp;•&nbsp; 🌍 ${escHtml(pr.country)}` : ''}
          ${naBlank(pr.registrationNumber) ? ` &nbsp;•&nbsp; 📋 ${escHtml(pr.registrationNumber)}` : ''}
        </div>
        ${naBlank(pr.activeIngredient) ? `<div class="stability-row">
          <span class="stability-row-label">Hoạt chất:</span>
          <span class="stability-row-val">${escHtml(pr.activeIngredient)}</span>
        </div>` : ''}
        ${naBlank(pr.dosageForm) ? `<div class="stability-row">
          <span class="stability-row-label">Dạng bào chế:</span>
          <span class="stability-row-val">${escHtml(pr.dosageForm)}</span>
        </div>` : ''}
        ${naBlank(pr.strength) ? `<div class="stability-row">
          <span class="stability-row-label">Hàm lượng:</span>
          <span class="stability-row-val">${escHtml(pr.strength)}</span>
        </div>` : ''}
        ${pr.excipients?.length ? `
        <div style="margin-top:.6rem">
          <div class="data-item-label" style="margin-bottom:6px">${typeof pr.excipients[0] === 'object' ? 'Tá dược & Vai trò' : 'Tá dược'}:</div>
          ${typeof pr.excipients[0] === 'object' ? `
            <div class="excipients-container" style="display:flex; flex-direction:column; gap:6px; margin-top:4px;">
              ${pr.excipients.map((e) => `
                <div class="excipient-row" style="display:flex; justify-content:space-between; align-items:center; background:rgba(15,23,42,0.02); border:1px solid rgba(15,23,42,0.05); padding:8px 12px; border-radius:6px; font-size:0.82rem; gap:12px;">
                  <div style="font-weight:600; color:var(--text-2); flex:1; text-align:left;">${escHtml(e.name)}</div>
                  <div style="color:var(--text-3); font-weight:500; font-size:0.8rem; width:80px; text-align:right; white-space:nowrap;">${escHtml(naBlank(e.amount))}</div>
                  <div style="font-size:0.72rem; color:#6d28d9; font-weight:600; background:rgba(139,92,246,0.12); border:1px solid rgba(139,92,246,0.25); padding:2px 8px; border-radius:100px; text-align:center; min-width:110px; letter-spacing:0.02em; white-space:nowrap;">${escHtml(e.role)}</div>
                </div>
              `).join('')}
            </div>
          ` : `
            <div class="excipients-list">
              ${pr.excipients.map((e) => `<span class="excipient-tag">${escHtml(e)}</span>`).join('')}
            </div>
          `}
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
  if (d.suggestedFormulas?.length || d.commonExcipients?.length || d.formulationInsights) {
    show('sra-insights-card');
    let insightHtml = '';
    // Các công thức đề xuất (tối đa 3) kèm quy trình sản xuất từng bước — hiển thị lên đầu.
    if (d.suggestedFormulas?.length) {
      insightHtml += `<div class="data-item-label" style="margin-bottom:8px">📋 Công thức đề xuất & quy trình sản xuất (${d.suggestedFormulas.length})</div>`;
      insightHtml += d.suggestedFormulas.map((f, i) => suggestedFormulaHtml(f, i)).join('');
    }
    if (d.formulationInsights) {
      insightHtml += `<div class="insight-box purple mt-2" style="margin-bottom:1rem;">${pickBox('sra', 'sra.insights', 'Đề xuất công thức tối ưu', blkText(d.formulationInsights))}<div class="insight-label purple">🤖 Đề xuất công thức tối ưu</div>${escHtml(d.formulationInsights)}</div>`;
    }
    // Tự tính nhóm vai trò + số lượt sử dụng thực tế từ excipients của TẤT CẢ sản phẩm phía trên
    // (chính xác hơn "commonExcipients" do AI tự liệt kê rời rạc, không có số lượt/nhóm vai trò).
    // Lưu ý thứ tự: "chống dính"/"trơn" phải được kiểm tra TRƯỚC "dính" (tá dược dính/binder),
    // vì "chống dính" chứa chữ "dính" nên nếu đổi thứ tự sẽ bị nhận nhầm thành tá dược dính.
    const roleGroups = [
      { key: 'filler',        label: 'Tá dược độn',        match: /độn|diluent|filler|làm đầy/i },
      { key: 'lubricant',     label: 'Tá dược trơn',       match: /trơn|bôi trơn|lubricant|chống dính|glidant|chống vón/i },
      { key: 'binder',        label: 'Tá dược dính',       match: /(?<!chống )dính|binder|kết dính/i },
      { key: 'disintegrant',  label: 'Tá dược rã',         match: /rã|disintegrant/i },
      { key: 'other',         label: 'Vai trò khác',       match: null },
    ];
    const countsByGroup = new Map(roleGroups.map(g => [g.key, new Map()]));
    for (const pr of products) {
      for (const ex of (pr.excipients || [])) {
        if (typeof ex !== 'object' || !ex.name) continue;
        const role = ex.role || '';
        const group = roleGroups.find(g => g.match && g.match.test(role)) || roleGroups[roleGroups.length - 1];
        const key = ex.name.trim().toLowerCase();
        const m = countsByGroup.get(group.key);
        const entry = m.get(key);
        if (entry) entry.count++;
        else m.set(key, { name: ex.name.trim(), count: 1 });
      }
    }

    const groupsHtml = roleGroups.map(g => {
      const entries = Array.from(countsByGroup.get(g.key).values()).sort((a, b) => b.count - a.count);
      if (!entries.length) return '';
      return `
        <div style="margin-bottom:10px">
          <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);margin-bottom:6px">${escHtml(g.label)}</div>
          <div class="tag-cloud">${entries.map(e => `<span class="tag tag-purple">${escHtml(e.name)} <span style="opacity:.65">×${e.count}</span></span>`).join('')}</div>
        </div>
      `;
    }).join('');

    if (groupsHtml) {
      insightHtml += `
        <div class="data-item-label" style="margin-bottom:8px">Tá dược cốt lõi phổ biến (theo vai trò, số lượt dùng trong ${products.length} sản phẩm ở trên)</div>
        ${groupsHtml}
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

function patentCardHtml(pt, pid) {
  let pickHtml = '';
  if (pid && pt && !pt.notRelevant) {
    const meta = [
      ['Số patent', pt.patentNumber], ['Tiêu đề', pt.title], ['Chủ đơn', pt.applicant],
      ['Ngày nộp đơn', pt.filingDate], ['Ngày công bố', pt.publicationDate], ['Dạng bào chế', pt.dosageForm],
    ];
    let note = '';
    if (pt.problemStatement) note += 'Vấn đề của hoạt chất cần xử lý:\n' + toText(pt.problemStatement) + '\n\n';
    if (pt.inventionSummary) note += 'Tóm tắt phát minh:\n' + toText(pt.inventionSummary) + '\n\n';
    if (pt.composition) {
      const cp = pt.composition;
      if (cp.examplesSummary) note += 'Ví dụ minh họa & phương pháp đánh giá:\n' + toText(cp.examplesSummary) + '\n\n';
      if (cp.selectionMethod) note += 'Phương pháp chọn công thức tối ưu:\n' + toText(cp.selectionMethod) + '\n\n';
      if (cp.optimalFormula) note += 'Công thức tối ưu:\n' + toText(cp.optimalFormula) + '\n\n';
      if (cp.manufacturingProcess) note += 'Quy trình bào chế:\n' + toText(cp.manufacturingProcess) + '\n\n';
    }
    if (pt.claims) note += 'Claims chính:\n' + toText(pt.claims);
    const blk = blkKV(meta, pt.url ? [{ url: pt.url, title: pt.title || pt.patentNumber || 'Patent' }] : undefined);
    if (note.trim()) blk.note = note.trim();
    pickHtml = pickBox('patents', pid, `Patent: ${pt.patentNumber || pt.title || ''}`, blk);
  }
  // Patent không thực sự về hoạt chất đang tra (chỉ nhắc thoáng qua) — hiện cảnh báo, không trình bày đầy đủ.
  if (pt && pt.notRelevant) {
    return `
      <div class="patent-card">
        <div class="patent-title">${escHtml(pt.title || 'Patent')}</div>
        <div class="insight-box amber mt-2"><div class="insight-label amber">⚠️ Patent không liên quan trực tiếp</div>
          <p style="line-height:1.6">${escHtml(pt.relevanceNote || 'Patent này không thực sự về hoạt chất bạn đang tra cứu (chỉ được nhắc thoáng qua trong tài liệu).')}</p>
        </div>
        ${pt.url ? `<a href="${escHtml(pt.url)}" target="_blank" rel="noopener" class="patent-link">🔗 Xem patent gốc</a>` : ''}
      </div>`;
  }
  return `
      <div class="patent-card">
        ${pickHtml}
        <div class="patent-number">${escHtml(pt.patentNumber || 'Patent')}</div>
        <div class="patent-title">${escHtml(pt.title || '–')}</div>
        <div class="patent-applicant">
          ${pt.applicant ? `🏢 ${escHtml(pt.applicant)}` : ''}
          ${pt.filingDate ? ` &nbsp;•&nbsp; 📅 Nộp đơn: ${escHtml(pt.filingDate)}` : ''}
          ${pt.publicationDate ? ` &nbsp;•&nbsp; 📢 Công bố: ${escHtml(pt.publicationDate)}` : ''}
        </div>
        ${pt.dosageForm ? `<div class="stability-row"><span class="stability-row-label">Dạng bào chế:</span><span class="stability-row-val">${escHtml(pt.dosageForm)}</span></div>` : ''}

        ${pt.problemStatement ? `<div class="insight-box amber mt-2"><div class="insight-label amber">🎯 Vấn đề của hoạt chất cần xử lý</div><p style="white-space:pre-line;line-height:1.6">${escHtml(pt.problemStatement)}</p></div>` : ''}

        ${pt.inventionSummary ? `<div class="insight-box mt-2"><div class="insight-label">📝 Tóm tắt phát minh</div><p style="white-space:pre-line;line-height:1.6">${escHtml(pt.inventionSummary)}</p></div>` : ''}

        ${pt.composition ? `
        <div class="divider"></div>
        <div class="patent-composition-label">📋 Chi tiết cấu trúc công thức</div>

        ${pt.composition.examplesSummary ? `<div class="insight-box mt-2"><div class="insight-label">🧪 Tóm tắt các ví dụ minh họa & phương pháp đánh giá</div><p style="white-space:pre-line;line-height:1.6">${escHtml(pt.composition.examplesSummary)}</p></div>` : ''}

        ${pt.composition.selectionMethod ? `<div class="insight-box mt-2"><div class="insight-label">🔬 Phương pháp chọn công thức tối ưu</div><p style="white-space:pre-line;line-height:1.6">${escHtml(pt.composition.selectionMethod)}</p></div>` : ''}

        ${pt.composition.optimalFormula ? `<div class="insight-box mt-2"><div class="insight-label">💎 Công thức tối ưu nhất (Preferred Embodiment)</div><p style="white-space:pre-line;line-height:1.6">${escHtml(pt.composition.optimalFormula)}</p></div>` : ''}

        ${pt.composition.manufacturingProcess ? `<div class="insight-box mt-2"><div class="insight-label">⚙️ Quy trình bào chế</div><p style="white-space:pre-line;line-height:1.6">${escHtml(pt.composition.manufacturingProcess)}</p></div>` : ''}

        ${pt.composition.innovativeFeatures ? `<div class="insight-box green mt-2"><div class="insight-label green">✨ Điểm đặc biệt</div>${escHtml(pt.composition.innovativeFeatures)}</div>` : ''}
        ` : ''}
        ${pt.claims ? `<div class="insight-box purple mt-2"><div class="insight-label purple">⚖️ Claims chính</div>${escHtml(pt.claims)}</div>` : ''}
        ${pt.url ? `<a href="${escHtml(pt.url)}" target="_blank" rel="noopener" class="patent-link">🔗 Xem patent gốc</a>` : ''}
      </div>
  `;
}

async function summarizePatentClick(id, url, title, pdfUrl) {
  const btn = document.getElementById(`patent-sum-btn-${id}`);
  const resultEl = document.getElementById(`patent-sum-result-${id}`);
  if (!btn || !resultEl) return;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '⏳ DeepSeek đang đọc patent...';
  resultEl.innerHTML = '';
  try {
    const data = await api('/api/summarize-patent', {
      url, title, pdfUrl, drugName: state.drugName, dosageForm: state.dosageForm, openaiKey: state.openaiKey
    });
    resultEl.innerHTML = patentCardHtml(data, 'patents.sum.' + id);
    updateProtocolCount();
    btn.style.display = 'none';
  } catch (e) {
    resultEl.innerHTML = `<div style="font-size:.75rem; color:var(--red);">Lỗi: ${escHtml(e.message)}</div>`;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function renderPatentsTab() {
  const d = state.patentData;
  if (!d) return;

  // patents (đọc sâu tự động) đã bỏ — giờ chỉ hiển thị danh sách tất cả patent tìm được; nhưng vẫn hỗ
  // trợ hiển thị thẻ đọc sâu nếu có (tương thích ngược / kết quả cũ trong lịch sử).
  const patents = d.patents || [];
  const otherPatents = d.otherPatents || [];
  const rawLinks = d.rawLinks || [];

  // Gộp otherPatents + rawLinks thành MỘT danh sách duy nhất, khử trùng lặp theo URL (ưu tiên bản có pdfUrl).
  const mergedMap = new Map();
  for (const p of otherPatents) { if (p.url && !mergedMap.has(p.url)) mergedMap.set(p.url, p); }
  for (const l of rawLinks) {
    if (!l.url) continue;
    if (mergedMap.has(l.url)) { if (!mergedMap.get(l.url).snippet && l.snippet) mergedMap.get(l.url).snippet = l.snippet; }
    else mergedMap.set(l.url, l);
  }
  const relatedPatents = [...mergedMap.values()];
  setInner('patent-count', (patents.length + relatedPatents.length) + ' patent');

  let patentHtml = '';
  if (patents.length) {
    patentHtml += patents.map((pt, i) => patentCardHtml(pt, 'patents.' + i)).join('');
  }

  if (relatedPatents.length) {
    patentHtml += `
      <div class="data-item-label" style="margin:1.2rem 0 .6rem">📄 ${relatedPatents.length} patent tìm được — bấm "DeepSeek tóm tắt" ở patent bạn cần</div>
      <div class="source-links">
        ${relatedPatents.map((p, i) => {
          const argsJson = escHtml(JSON.stringify([`op${i}`, p.url, p.title || '', p.pdfUrl || '']));
          return `
          <div class="source-link-item" style="margin-bottom: 12px; padding: 10px; background: ${p.matchBoth ? 'rgba(16,185,129,0.08)' : 'rgba(15,23,42,0.03)'}; border-radius: 6px; border-left: 3px solid ${p.matchBoth ? '#10b981' : '#94a3b8'};">
            <div style="font-weight: 600; color: #0f172a; font-size: 0.85rem; margin-bottom: 4px;">
              ${p.matchBoth ? '<span class="tag tag-green" style="font-size:.62rem;margin-right:6px;vertical-align:middle">✓ Khớp hoạt chất + dạng bào chế</span>' : ''}
              <a href="${escHtml(p.url)}" target="_blank" rel="noopener" style="color: #0f172a; text-decoration: none;">${escHtml(p.title || 'Xem patent')}</a>
            </div>
            <div style="font-size:.72rem;color:var(--text-3);margin-bottom:4px;word-break:break-all;">${escHtml(p.url)}</div>
            ${p.snippet ? `<div style="font-size:.78rem;color:var(--text-3);margin-bottom:6px;">${escHtml(p.snippet)}</div>` : ''}
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <button id="patent-sum-btn-op${i}" class="tag tag-blue" style="font-size:.7rem; cursor:pointer; border:none;"
                onclick="summarizePatentClick.apply(null, ${argsJson})">🔎 DeepSeek đọc & tóm tắt patent này</button>
              <a href="${escHtml(p.url)}" target="_blank" rel="noopener" style="font-size:.7rem;color:var(--blue);text-decoration:none;">🔗 Link tham khảo</a>
            </div>
            <div id="patent-sum-result-op${i}" style="margin-top:8px;"></div>
          </div>`;
        }).join('')}
      </div>
    `;
  }

  if (!patents.length && !relatedPatents.length) {
    patentHtml = '<p class="text-3 text-sm" style="padding:1rem">Không tìm thấy patent phù hợp.</p>';
  }

  setInner('sec-patents', patentHtml);

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

  // "Liên kết patent gốc" đã được GỘP vào danh sách "patent liên quan" ở trên — ẩn card riêng này đi.
  hide('patent-links-card');
}

function renderPatentsError(msg) {
  setInner('sec-patents', errorBox(msg));
}

// ── Error Box ─────────────────────────────────────────────────────────────────

function errorBox(msg) {
  return `<div class="error-box"><span>❌</span><span>${escHtml(msg)}</span></div>`;
}

// ── Render: Pharmacopoeia Tab ─────────────────────────────────────────────────

const BOOK_COLORS = {
  'USP': { bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.35)', text: '#1d4ed8' },
  'BP':  { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.35)', text: '#6ee7b7' },
  'EP':  { bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.35)', text: '#6d28d9' },
  'JP':  { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.35)', text: '#b45309' },
};

function bookBadge(book) {
  const b = BOOK_COLORS[book] || { bg: 'rgba(100,116,139,0.12)', border: 'rgba(100,116,139,0.35)', text: '#475569' };
  return `<span style="font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:100px;background:${b.bg};border:1px solid ${b.border};color:${b.text};letter-spacing:.04em">${escHtml(book)}</span>`;
}

function renderPharmaTab() {
  const data = state.pharmaData;
  if (!data || data.total === 0) {
    setInner('sec-pharma-list', `<div class="empty-state" style="padding:2rem">
      <div class="empty-state-icon">📭</div>
      <div class="empty-state-sub">Không tìm thấy monograph nào cho <strong>${escHtml(state.drugName)}</strong> trong cơ sở dữ liệu dược điển.</div>
    </div>`);
    setInner('pharma-count', '');
    return;
  }

  setInner('pharma-count', `<span style="font-size:.75rem;color:var(--text-3)">${data.total} monograph</span>`);

  const grouped = data.grouped || {};
  const formOrder = ['Tablet','Extended-Release Tablet','Effervescent Tablet','Chewable Tablet','Dispersible Tablet',
    'Capsule','Extended-Release Capsule','Oral Solution','Suspension','Oral Drops','Syrup','Granules','Powder',
    'Injection/Infusion','Suppository','Topical','Ophthalmic','Transdermal','General/Bulk'];

  // Sắp xếp dạng bào chế theo thứ tự ưu tiên
  const sortedForms = Object.keys(grouped).sort((a, b) => {
    const ia = formOrder.indexOf(a); const ib = formOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  let html = `<div style="margin-bottom:1rem;padding:.75rem 1rem;background:rgba(16,185,129,0.07);border:1px solid rgba(16,185,129,0.2);border-radius:10px;font-size:.82rem;color:var(--text-2)">
    💡 <strong>Tìm thấy ${data.total} monograph</strong> cho <strong>${escHtml(state.drugName)}</strong>. Bấm vào tiêu đề monograph cụ thể dưới đây để AI tự động xây dựng tiêu chuẩn chất lượng 100% theo Dược điển đó.
  </div>`;

  for (const form of sortedForms) {
    const entries = grouped[form];
    const formId = 'form-' + form.replace(/[^a-zA-Z0-9]/g, '_');
    html += `
    <div style="margin-bottom:1.2rem">
      <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.6rem">
        <div style="font-size:.85rem;font-weight:700;color:var(--text-1)">${escHtml(form)}</div>
        <span style="font-size:.7rem;color:var(--text-3)">${entries.length} monograph</span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:.6rem">`;
    for (const m of entries) {
      const viewUrl = (m.pdfUrl || '').replace('/preview', '/view');
      const mJson = JSON.stringify(m).replace(/"/g, '&quot;').replace(/'/g, '&#039;');
      html += `
      <div class="monograph-item" style="display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:8px;
        background:rgba(15,23,42,0.04);border:1px solid rgba(15,23,42,0.1);font-size:.76rem;transition:all .15s"
        onmouseover="this.style.borderColor='rgba(99,102,241,.5)';"
        onmouseout="this.style.borderColor='rgba(15,23,42,0.1)';">
        <span style="cursor:pointer;color:var(--text-2);display:inline-flex;align-items:center;gap:6px;font-weight:600"
          onclick="selectMonograph(${mJson})"
          onmouseover="this.style.color='#4338ca'"
          onmouseout="this.style.color='var(--text-2)'">
          ${bookBadge(m.book)} ${escHtml(m.title)} ⚡
        </span>
        <a href="${escHtml(viewUrl)}" target="_blank" rel="noopener" title="Xem PDF bản gốc"
          style="color:var(--text-3);text-decoration:none;font-size:.82rem;display:inline-flex;align-items:center;transition:color .15s"
          onmouseover="this.style.color='var(--blue)'"
          onmouseout="this.style.color='var(--text-3)'">📄</a>
      </div>`;
    }
    html += `</div></div>`;
  }

  setInner('sec-pharma-list', html);
}

async function selectMonograph(monograph) {
  const { drugName, openaiKey } = state;

  // Cập nhật UI tiêu đề
  document.getElementById('pharma-standards-title').textContent =
    `Tiêu chuẩn chất lượng – ${drugName} – ${monograph.title} (${monograph.book})`;

  // Hiển thị các card với loading
  show('pharma-standards-card');
  show('pharma-equipment-card');
  show('pharma-methods-card');

  const loadingHtml = (withBar) => `<div style="padding:2rem;text-align:center">
    <div style="font-size:1.5rem;margin-bottom:.5rem">⏳</div>
    <div style="font-size:.85rem;color:var(--text-2)" id="pharma-std-msg">AI đang xây dựng tiêu chuẩn theo dược điển ${escHtml(monograph.book)}…</div>
    <div style="margin:.75rem auto 0;max-width:320px;height:6px;background:rgba(15,23,42,.06);border-radius:10px;overflow:hidden">
      <div id="pharma-std-bar" style="height:100%;width:5%;background:linear-gradient(90deg,#6366f1,#8b5cf6);border-radius:10px;transition:width .4s ease"></div>
    </div>
    ${withBar ? `<div id="pharma-std-pct" style="font-size:.78rem;color:var(--text-3);margin-top:6px;font-weight:600">5%</div>` : ''}
  </div>`;
  setInner('sec-pharma-standards', loadingHtml(true));
  setInner('sec-pharma-hplc', loadingHtml(false));
  setInner('sec-pharma-chemicals', loadingHtml(false));

  // Scroll đến card
  document.getElementById('pharma-standards-card').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Polling tiến độ %
  const searchId = 'std_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const poll = setInterval(async () => {
    try {
      const res = await fetch(`/api/progress?id=${searchId}`);
      const data = await res.json();
      const p = data.pharmaStandards;
      if (p) {
        const bar = document.getElementById('pharma-std-bar');
        const pct = document.getElementById('pharma-std-pct');
        const msg = document.getElementById('pharma-std-msg');
        if (bar) bar.style.width = p.percent + '%';
        if (pct) pct.textContent = p.percent + '%';
        if (msg && p.message) msg.textContent = p.message;
      }
    } catch (e) { /* bỏ qua lỗi polling */ }
  }, 1000);

  try {
    const result = await api('/api/pharmacopoeia/standards', {
      drugName,
      dosageForm: state.dosageForm || 'Tablet',
      selectedMonograph: monograph,
      openaiKey,
      searchId
    });
    clearInterval(poll);
    renderPharmaStandards(result);
  } catch (e) {
    clearInterval(poll);
    setInner('sec-pharma-standards', errorBox(e.message));
    setInner('sec-pharma-hplc', '');
    setInner('sec-pharma-chemicals', '');
  }
}

function renderPharmaStandards(data) {
  // ── Bảng I: Tiêu chuẩn chất lượng ──────────────────────────────────────────
  const qs = data.qualityStandards || [];
  if (qs.length) {
    let tableHtml = `<div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead>
        <tr style="background:rgba(99,102,241,0.15)">
          <th style="padding:10px 12px;text-align:center;border:1px solid rgba(15,23,42,.1);width:40px;font-weight:700;color:var(--text-1)">STT</th>
          <th style="padding:10px 12px;text-align:left;border:1px solid rgba(15,23,42,.1);width:130px;font-weight:700;color:var(--text-1)">Chỉ tiêu</th>
          <th style="padding:10px 12px;text-align:left;border:1px solid rgba(15,23,42,.1);font-weight:700;color:var(--text-1)">Yêu cầu</th>
          <th style="padding:10px 12px;text-align:center;border:1px solid rgba(15,23,42,.1);width:140px;font-weight:700;color:var(--text-1)">Dược điển tham chiếu</th>
        </tr>
      </thead><tbody>`;
    qs.forEach((row, i) => {
      const bg = i % 2 === 0 ? 'rgba(15,23,42,0.02)' : 'rgba(15,23,42,0.005)';
      tableHtml += `<tr style="background:${bg}">
        <td style="padding:9px 12px;border:1px solid rgba(15,23,42,.07);text-align:center;font-weight:700;color:var(--text-3)">${escHtml(String(row.stt || i+1))}</td>
        <td style="padding:9px 12px;border:1px solid rgba(15,23,42,.07);font-weight:600;color:var(--text-1)">${escHtml(row.chiTieu || '')}</td>
        <td style="padding:9px 12px;border:1px solid rgba(15,23,42,.07);color:var(--text-2);line-height:1.6">${escHtml(row.yeuCau || '').replace(/\n/g, '<br>')}</td>
        <td style="padding:9px 12px;border:1px solid rgba(15,23,42,.07);text-align:center">
          <span style="font-size:.7rem;font-weight:600;color:#b45309">${escHtml(row.duocDien || '')}</span>
        </td>
      </tr>`;
    });
    tableHtml += `</tbody></table></div>`;
    const qsBlock = blkTable(['STT', 'Chỉ tiêu', 'Yêu cầu', 'Dược điển'],
      qs.map((r, i) => [String(r.stt || i + 1), r.chiTieu || '', r.yeuCau || '', r.duocDien || '']));
    setInner('sec-pharma-standards', pickBox('pharma', 'pharma.standards', 'Bảng tiêu chuẩn chất lượng', qsBlock) + tableHtml);
  } else {
    setInner('sec-pharma-standards', errorBox('Không có dữ liệu tiêu chuẩn.'));
  }

  // ── Bảng II: Điều kiện HPLC ─────────────────────────────────────────────────
  const hplc = data.hplcConditions || [];
  if (hplc.length) {
    let h = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead><tr style="background:rgba(59,130,246,0.15)">
        <th style="padding:10px 12px;text-align:left;border:1px solid rgba(15,23,42,.1);font-weight:700;color:var(--text-1)">Thông số</th>
        <th style="padding:10px 12px;text-align:left;border:1px solid rgba(15,23,42,.1);font-weight:700;color:var(--text-1)">Giá trị / Yêu cầu</th>
        <th style="padding:10px 12px;text-align:left;border:1px solid rgba(15,23,42,.1);font-weight:700;color:var(--text-1)">Ghi chú</th>
      </tr></thead><tbody>`;
    hplc.forEach((row, i) => {
      const bg = i % 2 === 0 ? 'rgba(15,23,42,0.02)' : 'rgba(15,23,42,0.005)';
      h += `<tr style="background:${bg}">
        <td style="padding:9px 12px;border:1px solid rgba(15,23,42,.07);font-weight:600;color:#1d4ed8">${escHtml(row.thongSo || '')}</td>
        <td style="padding:9px 12px;border:1px solid rgba(15,23,42,.07);color:var(--text-1);font-weight:500">${escHtml(row.giaTriYeuCau || '')}</td>
        <td style="padding:9px 12px;border:1px solid rgba(15,23,42,.07);color:var(--text-3);font-style:italic;font-size:.76rem">${escHtml(row.ghiChu || '')}</td>
      </tr>`;
    });
    h += `</tbody></table></div>`;
    const hplcBlock = blkTable(['Thông số', 'Giá trị / Yêu cầu', 'Ghi chú'],
      hplc.map((r) => [r.thongSo || '', r.giaTriYeuCau || '', r.ghiChu || '']));
    setInner('sec-pharma-hplc', pickBox('pharma', 'pharma.hplc', 'Điều kiện sắc ký (HPLC)', hplcBlock) + h);
  } else {
    setInner('sec-pharma-hplc', `<p style="color:var(--text-3);font-size:.85rem;padding:1rem">Không áp dụng hoặc không có dữ liệu cột sắc ký.</p>`);
  }

  // ── Bảng III: Hóa chất ───────────────────────────────────────────────────────
  const chems = data.chemicals || [];
  if (chems.length) {
    const loaiColors = {
      'Chất đối chiếu': '#b45309', 'Dung môi': '#6ee7b7', 'Thuốc thử': '#6d28d9', 'Đệm': '#1d4ed8',
    };
    let c = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead><tr style="background:rgba(139,92,246,0.15)">
        <th style="padding:10px 12px;text-align:left;border:1px solid rgba(15,23,42,.1);font-weight:700;color:var(--text-1)">Tên hóa chất</th>
        <th style="padding:10px 12px;text-align:center;border:1px solid rgba(15,23,42,.1);width:130px;font-weight:700;color:var(--text-1)">Loại</th>
        <th style="padding:10px 12px;text-align:left;border:1px solid rgba(15,23,42,.1);font-weight:700;color:var(--text-1)">Mục đích sử dụng</th>
      </tr></thead><tbody>`;
    chems.forEach((row, i) => {
      const bg = i % 2 === 0 ? 'rgba(15,23,42,0.02)' : 'rgba(15,23,42,0.005)';
      const loai = row.loai || '';
      const loaiColor = Object.entries(loaiColors).find(([k]) => loai.includes(k))?.[1] || '#475569';
      c += `<tr style="background:${bg}">
        <td style="padding:9px 12px;border:1px solid rgba(15,23,42,.07);font-weight:600;color:var(--text-1)">${escHtml(row.ten || '')}</td>
        <td style="padding:9px 12px;border:1px solid rgba(15,23,42,.07);text-align:center">
          <span style="font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:100px;background:rgba(15,23,42,.06);color:${loaiColor}">${escHtml(loai)}</span>
        </td>
        <td style="padding:9px 12px;border:1px solid rgba(15,23,42,.07);color:var(--text-2)">${escHtml(row.mucDich || '')}</td>
      </tr>`;
    });
    c += `</tbody></table></div>`;
    const chemBlock = blkTable(['Tên hóa chất', 'Loại', 'Mục đích sử dụng'],
      chems.map((r) => [r.ten || '', r.loai || '', r.mucDich || '']));
    setInner('sec-pharma-chemicals', pickBox('pharma', 'pharma.chemicals', 'Hóa chất – thuốc thử', chemBlock) + c);
  } else {
    setInner('sec-pharma-chemicals', `<p style="color:var(--text-3);font-size:.85rem;padding:1rem">Không có dữ liệu hóa chất.</p>`);
  }

  // ── Bảng IV: Phương pháp tiến hành (quy trình chi tiết dịch từ dược điển) ─────
  const methods = data.testMethods || [];
  if (methods.length) {
    let m = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead><tr style="background:rgba(16,185,129,0.15)">
        <th style="padding:10px 12px;text-align:center;border:1px solid rgba(15,23,42,.1);width:40px;font-weight:700;color:var(--text-1)">STT</th>
        <th style="padding:10px 12px;text-align:left;border:1px solid rgba(15,23,42,.1);width:150px;font-weight:700;color:var(--text-1)">Chỉ tiêu</th>
        <th style="padding:10px 12px;text-align:left;border:1px solid rgba(15,23,42,.1);font-weight:700;color:var(--text-1)">Phương pháp tiến hành</th>
      </tr></thead><tbody>`;
    methods.forEach((row, i) => {
      const bg = i % 2 === 0 ? 'rgba(15,23,42,0.02)' : 'rgba(15,23,42,0.005)';
      m += `<tr style="background:${bg}">
        <td style="padding:9px 12px;border:1px solid rgba(15,23,42,.07);text-align:center;font-weight:700;color:var(--text-3)">${i + 1}</td>
        <td style="padding:9px 12px;border:1px solid rgba(15,23,42,.07);font-weight:600;color:var(--text-1);vertical-align:top">${escHtml(row.chiTieu || '')}</td>
        <td style="padding:9px 12px;border:1px solid rgba(15,23,42,.07);color:var(--text-2);line-height:1.65;vertical-align:top">${escHtml(row.phuongPhap || '').replace(/\n/g, '<br>')}</td>
      </tr>`;
    });
    m += `</tbody></table></div>`;
    const methodsBlock = blkTable(['STT', 'Chỉ tiêu', 'Phương pháp tiến hành'],
      methods.map((r, i) => [String(i + 1), r.chiTieu || '', r.phuongPhap || '']));
    setInner('sec-pharma-methods', pickBox('pharma', 'pharma.methods', 'Phương pháp tiến hành (kiểm nghiệm)', methodsBlock) + m);
  } else {
    setInner('sec-pharma-methods', `<p style="color:var(--text-3);font-size:.85rem;padding:1rem">Không có dữ liệu phương pháp tiến hành.</p>`);
  }
  updateProtocolCount();
}

// ── Render: Compatibility Tab ──────────────────────────────────────────────────
function renderCompatibilityTab() {
  const data = state.compatibilityData;
  if (!data) return;

  const isAI = data.dataSource === 'ai-analysis';
  const srcBadge = isAI
    ? '<span class="tag tag-cyan" style="font-size:.72rem">🤖 AI phân tích (DeepSeek — đọc tài liệu thật)</span>'
    : '<span class="tag tag-cyan" style="font-size:.72rem">🧪 PharmDE Database</span>';
  // Khối nguồn tham khảo (chỉ có ở chế độ AI) — link bấm được.
  const sourcesHtml = (isAI && data.sources && data.sources.length)
    ? `<div class="data-item-label" style="margin:1.2rem 0 .6rem">📚 Nguồn tham khảo</div>
       <div class="source-links">${data.sources.map((s, i) => `
         <div class="source-link-item">
           <div class="source-link-num">${i + 1}</div>
           <div class="source-link-text">
             <a href="${escHtml(s.url)}" target="_blank" rel="noopener" class="source-link-title">${escHtml(s.title || s.url)}</a>
             <span class="source-link-url">${escHtml(s.url)}</span>
           </div>
         </div>`).join('')}</div>`
    : '';
  const footerHtml = isAI
    ? `<div style="margin-top:1.5rem;font-size:0.75rem;color:var(--text-3);text-align:right">Nguồn: 🤖 DeepSeek phân tích từ tài liệu dược (PharmDE tạm không phản hồi)</div>`
    : `<div style="margin-top:1.5rem;font-size:0.75rem;color:var(--text-3);text-align:right">Nguồn dữ liệu dự đoán: <a href="${escHtml(data.sourceUrl || '#')}" target="_blank" style="color:var(--cyan);text-decoration:underline">PharmDE Database</a></div>`;

  setInner('compatibility-smiles-info', data.smiles
    ? `SMILES: <code style="background:rgba(15,23,42,0.06);padding:2px 6px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:var(--cyan)">${escHtml(data.smiles)}</code>`
    : '');

  if (!data.incompatibilities || data.incompatibilities.length === 0) {
    setInner('sec-compatibility-results', `
      <div style="margin-bottom:1rem">${srcBadge}</div>
      <div class="empty-state" style="padding: 3rem 2rem; border: 1px dashed rgba(16,185,129,0.3); background: rgba(16,185,129,0.03); border-radius: var(--r-lg)">
        <div class="empty-state-icon" style="color:var(--green)">✅</div>
        <div class="empty-state-title" style="color:var(--green)">Không phát hiện tương tác không tương hợp</div>
        <div class="empty-state-sub">${escHtml(data.overview || (isAI
          ? 'AI không tìm thấy tương tác/không tương hợp đáng kể được công bố giữa hoạt chất này với các tá dược thông dụng.'
          : 'Hệ thống chuyên gia PharmDE không phát hiện nhóm cấu trúc hoặc phản ứng không tương hợp nào giữa hoạt chất này với các tá dược thông dụng.'))}</div>
      </div>
      ${sourcesHtml}
    `);
    return;
  }

  let html = `<div style="margin-bottom:1rem">${srcBadge}</div>`;
  // Tổng quan (chỉ có ở chế độ AI)
  if (isAI && data.overview) html += `<div class="insight-box mt-2" style="margin-bottom:1rem"><div class="insight-label">🧭 Tổng quan</div><p style="line-height:1.6">${escHtml(data.overview)}</p></div>`;
  html += `<div style="display:flex;flex-direction:column;gap:1.5rem">`;
  data.incompatibilities.forEach((item, idx) => {
    const cBlock = blkKV([
      ['Loại phản ứng', item.reactionType],
      ['Mô tả tương tác', item.description],
      ['Nhóm cấu trúc đích', (item.riskGroups || '') + (item.riskGroupsFormula ? ` (${item.riskGroupsFormula})` : '')],
      ['Nhóm tá dược rủi ro', item.riskExcipientType],
      ['Tá dược rủi ro cụ thể', (item.riskExcipientNames || []).join(', ')],
    ], (isAI && data.sources && data.sources.length) ? data.sources : undefined);
    html += `
      <div class="compatibility-item" style="display: flex; flex-wrap: wrap; gap: 1.5rem; border-bottom: 1px solid var(--card-border); padding-bottom: 1.5rem; align-items: flex-start;">
        <div style="width:100%">${pickBox('compat', 'compat.' + idx, item.title || ('Tương tác ' + (idx + 1)), cBlock)}</div>
        ${item.imageUrl ? `
          <div class="compatibility-img-wrap" style="width: 140px; flex-shrink: 0; background: #fff; border-radius: var(--r-md); padding: 8px; display: flex; align-items: center; justify-content: center; aspect-ratio: 1; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15); transition: transform 0.2s ease;">
            <img src="${escHtml(item.imageUrl)}" style="max-width: 100%; max-height: 100%; object-fit: contain;" />
          </div>
        ` : ''}
        <div style="flex-grow: 1;">
          <h4 style="color: var(--cyan); margin-bottom: 0.6rem; font-size: 1.05rem; font-weight: 700;">${escHtml(item.title)}</h4>
          
          <div style="display: grid; grid-template-columns: 150px 1fr; gap: 0.5rem 1rem; font-size: 0.82rem; margin-bottom: 0.8rem; line-height: 1.5;">
            <span style="color: var(--text-3); font-weight: 600;">Loại phản ứng:</span>
            <span style="color: var(--text-1); font-weight: 500;">${escHtml(item.reactionType || 'N/A')}</span>
            
            <span style="color: var(--text-3); font-weight: 600;">Mô tả tương tác:</span>
            <span style="color: var(--text-2);">${escHtml(item.description || 'N/A')}</span>
            
            <span style="color: var(--text-3); font-weight: 600;">Nhóm cấu trúc đích:</span>
            <span style="color: var(--text-2); font-family: 'JetBrains Mono', monospace; font-size: 0.78rem;">${escHtml(item.riskGroups || 'N/A')} ${item.riskGroupsFormula ? `(${escHtml(item.riskGroupsFormula)})` : ''}</span>
            
            <span style="color: var(--text-3); font-weight: 600;">Nhóm tá dược rủi ro:</span>
            <span style="color: var(--text-1); font-weight: 500;">${escHtml(item.riskExcipientType || 'N/A')}</span>
          </div>
          
          ${item.riskExcipientNames && item.riskExcipientNames.length ? `
            <div style="margin-top: 0.5rem;">
              <span style="color: var(--text-3); font-weight: 600; font-size: 0.82rem; display: block; margin-bottom: 0.4rem;">Danh sách tá dược rủi ro cụ thể:</span>
              <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                ${item.riskExcipientNames.map(name => `
                  <span style="background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.2); color: var(--amber); padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 500;">
                    ${escHtml(name)}
                  </span>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  });
  html += `</div>`;
  
  html += sourcesHtml;
  html += footerHtml;

  setInner('sec-compatibility-results', html);
}

function renderCompatibilityError(msg) {
  setInner('sec-compatibility-results', `
    <div class="empty-state" style="padding: 3rem 2rem; border: 1px dashed rgba(239,68,68,0.3); background: rgba(239,68,68,0.03); border-radius: var(--r-lg)">
      <div class="empty-state-icon" style="color:var(--red)">❌</div>
      <div class="empty-state-title" style="color:var(--red)">Lỗi phân tích tương tác tá dược</div>
      <div class="empty-state-sub">${escHtml(msg)}</div>
    </div>
  `);
}

// ── Clinical / Pharmacology info Tab ──────────────────────────────────────────
function renderClinicalTab() {
  const d = state.clinicalData;
  if (!d) return;

  // Một số trường AI đôi khi trả về object/array thay vì chuỗi — chuyển về text đọc được, tránh "[object Object]".
  const keyLabel = {
    adults: 'Người lớn', adult: 'Người lớn', children: 'Trẻ em', child: 'Trẻ em', pediatric: 'Trẻ em',
    elderly: 'Người cao tuổi', renal: 'Suy thận', renalImpairment: 'Suy thận', hepatic: 'Suy gan',
    hepaticImpairment: 'Suy gan', maxDose: 'Liều tối đa', maximum: 'Liều tối đa', administration: 'Cách dùng',
    route: 'Đường dùng', frequency: 'Số lần dùng', duration: 'Thời gian dùng', note: 'Lưu ý', notes: 'Lưu ý',
  };
  const toText = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(toText).filter(Boolean).join('\n');
    if (typeof v === 'object') {
      return Object.entries(v).map(([k, val]) => {
        const t = toText(val);
        return t ? `${keyLabel[k] || k}: ${t}` : '';
      }).filter(Boolean).join('\n');
    }
    return String(v);
  };

  const src = (Array.isArray(d.sources) && d.sources.length) ? d.sources : undefined;
  const box = (pid, icon, label, content) => {
    const txt = toText(content);
    if (!txt) return '';
    const blk = blkText(txt); if (src) blk.sources = src;
    return `<div class="insight-box mt-2">${pickBox('clinical', pid, label, blk)}<div class="insight-label">${icon} ${escHtml(label)}</div><p style="white-space:pre-line;line-height:1.7">${escHtml(txt)}</p></div>`;
  };

  let html = '';
  // 1. Chỉ định điều trị
  html += box('clinical.indications', '🎯', 'Chỉ định điều trị', d.indications);
  // 2. Liều lượng và cách dùng
  html += box('clinical.dosage', '💊', 'Liều lượng và cách dùng', d.dosageAdministration);
  // 3. Dược động học (4 mục con)
  const pk = d.pharmacokinetics;
  if (pk && (pk.absorption || pk.distribution || pk.metabolism || pk.elimination)) {
    const row = (lbl, v) => { const t = toText(v); return t ? `<div class="stability-row"><span class="stability-row-label">${escHtml(lbl)}</span><span class="stability-row-val" style="white-space:pre-line">${escHtml(t)}</span></div>` : ''; };
    const pkPick = pickBox('clinical', 'clinical.pk', 'Tính chất dược động học', blkKV([
      ['Hấp thu', pk.absorption], ['Phân bố', pk.distribution], ['Chuyển hóa', pk.metabolism], ['Thải trừ', pk.elimination],
    ], src));
    html += `<div class="insight-box mt-2">${pkPick}<div class="insight-label">📈 Tính chất dược động học</div>
      ${row('Hấp thu:', pk.absorption)}
      ${row('Phân bố:', pk.distribution)}
      ${row('Chuyển hóa:', pk.metabolism)}
      ${row('Thải trừ:', pk.elimination)}
    </div>`;
  } else if (typeof pk === 'string') {
    html += box('clinical.pk', '📈', 'Tính chất dược động học', pk);
  }
  // 4. Dược lực học
  html += box('clinical.pd', '⚡', 'Tính chất dược lực học', d.pharmacodynamics);
  // 5. Giải phóng thuốc
  html += box('clinical.release', '🌀', 'Giải phóng thuốc', d.drugRelease);
  // 6. Thành phần tá dược
  if (Array.isArray(d.excipients) && d.excipients.length) {
    const exItems = d.excipients.map((e) => typeof e === 'string' ? e : (e.name ? (e.role ? e.name + ' — ' + e.role : e.name) : toText(e)));
    html += `<div class="insight-box mt-2">${pickBox('clinical', 'clinical.excipients', 'Thành phần tá dược thường dùng', blkList(exItems, src))}<div class="insight-label">🧪 Thành phần tá dược thường dùng</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:4px">
        ${d.excipients.map((e) => `<div style="background:rgba(15,23,42,0.02);border:1px solid rgba(15,23,42,0.05);padding:7px 12px;border-radius:6px;font-size:0.82rem;color:var(--text-2)">${escHtml(typeof e === 'string' ? e : (e.name ? (e.role ? e.name + ' — ' + e.role : e.name) : toText(e)))}</div>`).join('')}
      </div>
    </div>`;
  } else if (typeof d.excipients === 'string' && d.excipients.trim()) {
    html += box('clinical.excipients', '🧪', 'Thành phần tá dược thường dùng', d.excipients);
  }

  // Nguồn tham khảo (link bấm được)
  if (Array.isArray(d.sources) && d.sources.length) {
    html += `<div class="data-item-label" style="margin:1.2rem 0 .6rem">📚 Nguồn tham khảo</div>
      <div class="source-links">
        ${d.sources.map((s, i) => `
          <div class="source-link-item">
            <div class="source-link-num">${i + 1}</div>
            <div class="source-link-text">
              <a href="${escHtml(s.url)}" target="_blank" rel="noopener" class="source-link-title">${escHtml(s.title || s.url)}</a>
              <span class="source-link-url">${escHtml(s.url)}</span>
            </div>
          </div>`).join('')}
      </div>`;
  }

  if (!html.trim()) html = '<p class="text-3 text-sm" style="padding:1rem">Không tìm thấy dữ liệu công bố cho hoạt chất này.</p>';
  setInner('sec-clinical', html);
}

function renderClinicalError(msg) {
  setInner('sec-clinical', errorBox(msg));
}

// ── Double-check: AI thứ 2 đối chiếu nguồn thật cho từng tab ───────────────────
const DC_SECTION_TAB = {
  drug: 'tab-drug', clinical: 'tab-clinical', stability: 'tab-stability',
  sra: 'tab-sra', patents: 'tab-patents', pharma: 'tab-pharma', compat: 'tab-compatibility',
};

async function doubleCheck(section) {
  const panel = document.getElementById(DC_SECTION_TAB[section]);
  const resultEl = document.getElementById('dc-result-' + section);
  const btn = panel ? panel.querySelector('.dc-btn') : null;
  if (!panel || !resultEl) return;

  // Lấy text đang hiển thị của tab làm "các thông tin cần kiểm" — bỏ thanh dc-toolbar + mọi nút.
  const clone = panel.cloneNode(true);
  clone.querySelectorAll('.dc-toolbar, button').forEach((el) => el.remove());
  const claimsText = (clone.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  if (claimsText.length < 40) {
    resultEl.innerHTML = `<span class="dc-badge dc-unknown">Chưa có dữ liệu để kiểm tra ở mục này — hãy tra cứu trước.</span>`;
    return;
  }

  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Đang đối chiếu nguồn...'; }
  resultEl.innerHTML = `<span class="dc-badge dc-unknown">⏳ AI thứ 2 đang tra nguồn thật để kiểm tra chéo...</span>`;
  try {
    const data = await api('/api/double-check', {
      section, drugName: state.drugName, dosageForm: state.dosageForm,
      claimsText, openaiKey: state.openaiKey,
    });
    resultEl.innerHTML = renderDoubleCheckBadge(data);
  } catch (e) {
    resultEl.innerHTML = `<span class="dc-badge dc-warn">Lỗi kiểm tra: ${escHtml(e.message)}</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel || '🔍 Double-check mục này'; }
  }
}

function renderDoubleCheckBadge(data) {
  const sourcesHtml = (data.sources && data.sources.length)
    ? `<div class="dc-sources"><div class="dc-sources-label">📚 Nguồn đã đối chiếu (${data.sources.length}):</div>
       ${data.sources.map((s) => `<a href="${escHtml(s.url)}" target="_blank" rel="noopener">${escHtml(s.title || s.url)}</a>`).join('')}</div>`
    : '';
  const summaryHtml = data.summary ? `<div class="dc-summary">${escHtml(data.summary)}</div>` : '';

  if (data.verdict === 'verified') {
    return `<div class="dc-out"><span class="dc-badge dc-ok">✓ Đã double-check — khớp nguồn thật</span>${summaryHtml}${sourcesHtml}</div>`;
  }
  if (data.verdict === 'issues') {
    const issues = (data.issues || []).map((it) => `
      <div class="dc-issue">
        <div class="dc-issue-claim">⚠️ ${escHtml(it.claim || '')}</div>
        ${it.problem ? `<div><b>Vấn đề:</b> ${escHtml(it.problem)}</div>` : ''}
        ${it.correction ? `<div><b>Đúng theo nguồn:</b> ${escHtml(it.correction)}</div>` : ''}
        ${it.sourceUrl ? `<div><a href="${escHtml(it.sourceUrl)}" target="_blank" rel="noopener">🔗 Nguồn</a></div>` : ''}
      </div>`).join('');
    return `<div class="dc-out"><span class="dc-badge dc-warn">⚠️ Phát hiện ${(data.issues || []).length} điểm cần xem lại</span>${summaryHtml}${issues}${sourcesHtml}</div>`;
  }
  // unknown
  return `<div class="dc-out"><span class="dc-badge dc-unknown">◐ Chưa đủ nguồn để xác minh chắc chắn</span>${summaryHtml}${sourcesHtml}</div>`;
}

// ── History Tab ───────────────────────────────────────────────────────────────

function formatHistoryDate(iso) {
  try {
    return new Date(iso).toLocaleString('vi-VN');
  } catch { return iso; }
}

async function loadHistoryTab() {
  const _t0 = performance.now();
  await appReady;
  const _tReady = performance.now();
  if (!supabase || !currentProfile) return;
  setInner('sec-history-list', '<div class="skeleton" style="height:120px;border-radius:12px;"></div>');
  try {
    // Chỉ tải các cột NHẸ cho danh sách — KHÔNG tải cột "data" (chứa toàn bộ dữ liệu nghiên cứu của
    // mỗi lượt, rất nặng). "data" chỉ được tải khi bấm mở 1 mục cụ thể (xem loadHistoryItem).
    // Giới hạn 200 dòng mới nhất để tránh tải quá nhiều nếu lịch sử rất dài.
    const { data, error } = await supabase
      .from('search_history')
      .select('id, drug_name, dosage_form, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    const _tQuery = performance.now();
    console.log(`[History] chờ appReady: ${(_tReady - _t0).toFixed(0)}ms | truy vấn: ${(_tQuery - _tReady).toFixed(0)}ms | số dòng: ${data ? data.length : 0}`);
    if (error) throw error;

    if (!data || data.length === 0) {
      setInner('sec-history-list', html`
        <div class="empty-state" style="padding:2rem">
          <div class="empty-state-icon">🕘</div>
          <div class="empty-state-sub">Chưa có lịch sử tra cứu nào.</div>
        </div>
      `);
      return;
    }

    const rows = data.map((row, i) => {
      return `
        <tr>
          <td>${i + 1}</td>
          <td><a href="#" onclick="loadHistoryItem('${row.id}'); return false;">💊 ${escHtml(row.drug_name)}</a></td>
          <td>${escHtml(row.dosage_form || '')}</td>
          <td>${escHtml(formatHistoryDate(row.created_at))}</td>
          <td><span class="status-badge green">Đã lưu</span></td>
        </tr>
      `;
    }).join('');
    setInner('sec-history-list', `
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th>STT</th><th>Hoạt chất</th><th>Dạng bào chế</th><th>Thời gian</th><th>Trạng thái</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  } catch (e) {
    setInner('sec-history-list', html`
      <div class="empty-state" style="padding:2rem">
        <div class="empty-state-icon">⚠️</div>
        <div class="empty-state-sub">Lỗi tải lịch sử: ${e.message}</div>
      </div>
    `);
  }
}

async function loadHistoryItem(id) {
  if (!supabase) return;
  // Tải dữ liệu ĐẦY ĐỦ của riêng mục này (cột "data" nặng) chỉ khi người dùng bấm mở.
  hide('empty-state');
  hide('results-section');
  show('loading-section');
  document.getElementById('loading-section')?.classList.add('active');
  let row;
  try {
    const res = await supabase
      .from('search_history')
      .select('data, drug_name, dosage_form')
      .eq('id', id).single();
    if (res.error) throw res.error;
    row = res.data;
  } catch (e) {
    hide('loading-section');
    show('results-section');
    alert('Không tải được lịch sử này: ' + (e.message || e));
    return;
  }
  document.getElementById('loading-section')?.classList.remove('active');
  hide('loading-section');

  const d = row.data || {};
  Object.assign(state, {
    drugName: row.drug_name,
    dosageForm: row.dosage_form,
    pubchemData: d.pubchemData || null,
    aiAnalysis: d.aiAnalysis || null,
    stabilityData: d.stabilityData || null,
    sraData: d.sraData || null,
    patentData: d.patentData || null,
    pharmaData: d.pharmaData || null,
    compatibilityData: d.compatibilityData || null,
    clinicalData: d.clinicalData || null,
  });
  clearProtocolItems();

  document.getElementById('drug-name').value = row.drug_name || '';
  if (row.dosage_form) document.getElementById('dosage-form').value = row.dosage_form;

  hide('empty-state');
  hide('loading-section');
  show('results-section');

  if (state.pubchemData) renderDrugTab();
  if (state.stabilityData) renderStabilityTab();
  if (state.sraData) renderSRATab();
  if (state.patentData) renderPatentsTab();
  if (state.pharmaData) renderPharmaTab();
  if (state.compatibilityData) renderCompatibilityTab();
  if (state.clinicalData) renderClinicalTab();

  switchPage('page-setup', document.getElementById('sidebar-setup-btn'));
  const firstTabBtn = document.querySelector('.tab-btn');
  if (firstTabBtn) switchTab('tab-clinical', firstTabBtn);
}

// ── Admin Tab ─────────────────────────────────────────────────────────────────

async function loadAdminTab() {
  await appReady;
  if (!supabase || !currentProfile || currentProfile.role !== 'admin') return;
  setInner('sec-admin-panel', '<div class="skeleton" style="height:120px;border-radius:12px;"></div>');
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, status, role, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const statusBadge = {
      pending:  '<span class="status-badge amber">Chờ duyệt</span>',
      approved: '<span class="status-badge green">Đã duyệt</span>',
      rejected: '<span class="status-badge red">Từ chối</span>',
    };
    const rows = (data || []).map((p, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escHtml(p.email)}${p.role === 'admin' ? ' <span class="status-badge blue">Admin</span>' : ''}</td>
        <td>${statusBadge[p.status] || escHtml(p.status)}</td>
        <td>${escHtml(formatHistoryDate(p.created_at))}</td>
        <td>
          <div style="display:flex;gap:0.5rem;">
            ${p.status !== 'approved' ? `<button onclick="setProfileStatus('${p.id}','approved')" style="padding:0.35rem 0.8rem;border:none;border-radius:8px;background:var(--green);color:#fff;cursor:pointer;font-size:0.78rem;font-weight:600;">Duyệt</button>` : ''}
            ${p.status !== 'rejected' ? `<button onclick="setProfileStatus('${p.id}','rejected')" style="padding:0.35rem 0.8rem;border:1px solid var(--red);border-radius:8px;background:transparent;color:var(--red);cursor:pointer;font-size:0.78rem;">Từ chối</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');
    setInner('sec-admin-panel', data && data.length ? `
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th>STT</th><th>Email</th><th>Trạng thái</th><th>Ngày tạo</th><th>Hành động</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    ` : '<div class="empty-state" style="padding:2rem"><div class="empty-state-sub">Chưa có tài khoản nào.</div></div>');
  } catch (e) {
    setInner('sec-admin-panel', html`
      <div class="empty-state" style="padding:2rem">
        <div class="empty-state-icon">⚠️</div>
        <div class="empty-state-sub">Lỗi tải danh sách: ${e.message}</div>
      </div>
    `);
  }
}

async function setProfileStatus(id, status) {
  try {
    const { error } = await supabase.from('profiles').update({ status }).eq('id', id);
    if (error) throw error;
    loadAdminTab();
  } catch (e) {
    alert('Lỗi cập nhật: ' + e.message);
  }
}

async function inviteUser() {
  const emailEl = document.getElementById('invite-email');
  const statusEl = document.getElementById('invite-status');
  const email = emailEl.value.trim();
  if (!email) return;
  setInner('invite-status', '<span style="color:var(--text-3);">Đang gửi lời mời...</span>');
  try {
    await api('/api/admin/invite-user', { email });
    setInner('invite-status', `<span style="color:var(--green,#2dd4bf);">Đã gửi lời mời tới ${escHtml(email)}.</span>`);
    emailEl.value = '';
    loadAdminTab();
  } catch (e) {
    setInner('invite-status', `<span style="color:var(--red,#ff6b6b);">Lỗi: ${escHtml(e.message)}</span>`);
  }
}

// ── Keyboard shortcut ─────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.target.id === 'drug-name' || e.target.id === 'dosage-form')) {
    startSearch();
  }
});

// ── Key Persistence & Defaults ────────────────────────────────────────────────
(function initKeys() {
  let savedOpenai = localStorage.getItem('openai_api_key') || '';
  let savedSerper = localStorage.getItem('serper_api_key') || '';

  // Dọn dẹp key cũ đã bị thu hồi khỏi localStorage của trình duyệt
  if (savedOpenai.includes('ejKtxBzOG6t')) {
    localStorage.removeItem('openai_api_key');
    savedOpenai = '';
  }
  if (savedSerper.includes('e9146f69445')) {
    localStorage.removeItem('serper_api_key');
    savedSerper = '';
  }

  const openaiEl = document.getElementById('openai-key');
  const serperEl = document.getElementById('serper-key');

  if (openaiEl) {
    openaiEl.value = savedOpenai;
  }
  if (serperEl) {
    serperEl.value = savedSerper;
  }
})();

// ── App Bootstrap (Supabase config + Auth gate) ────────────────────────────────
async function initApp() {
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      console.error('Thiếu cấu hình Supabase (SUPABASE_URL / SUPABASE_ANON_KEY) trên server.');
      return;
    }
    supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    await initAuthGate();
    _resolveAppReady();
    supabase.auth.onAuthStateChange((event) => {
      // Bỏ qua sự kiện làm mới token định kỳ (không có gì thay đổi về đăng nhập/quyền
      // hạn) — chỉ initAuthGate() lại khi thực sự đăng nhập/đăng xuất/cập nhật user.
      if (event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') return;
      initAuthGate();
    });
  } catch (e) {
    console.error('Không thể khởi tạo Supabase:', e);
  }
}
initApp();
