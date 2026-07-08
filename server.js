const express = require('express');
const axios   = require('axios');
const path    = require('path');
const pdfParse = require('pdf-parse');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Utilities ─────────────────────────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, params = {}, timeoutMs = 60000, extraHeaders = {}, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, {
        params,
        headers: { 'User-Agent': 'DrugResearchPro/1.0', Accept: 'application/json', ...extraHeaders },
        timeout: timeoutMs,
      });
      return res.data;
    } catch (e) {
      if (i === retries - 1) throw e;
      console.error(`GET ${url} failed (${e.message}). Retrying ${i+1}/${retries}...`);
      await delay(2000);
    }
  }
}

async function tryPubchem(urlPath, params = {}) {
  try { return await get(`https://pubchem.ncbi.nlm.nih.gov${urlPath}`, params, 7000); }
  catch { return null; }
}

function extractPubchemValues(data) {
  if (!data) return [];
  const vals = [];
  const dig = (arr) => {
    for (const item of arr || []) {
      for (const info of item.Information || []) {
        const swm = info?.Value?.StringWithMarkup;
        if (swm) vals.push(swm.map((s) => s.String).join(''));
        const num = info?.Value?.Number;
        if (num) vals.push(num.join(', ') + (info.Value.Unit ? ' ' + info.Value.Unit : ''));
      }
      if (item.Section) dig(item.Section);
    }
  };
  try { dig(data.Record?.Section || []); } catch {}
  return vals.slice(0, 5);
}

// Lấy dữ liệu thực nghiệm từ PubChem theo từng heading, trả về {value, sourceUrl}[]
async function fetchPubchemSection(cid, heading) {
  const data = await tryPubchem(
    `/rest/pug_view/data/compound/${cid}/JSON`,
    { heading }
  );
  const vals = extractPubchemValues(data);
  if (!vals.length) return [];
  const sourceUrl = `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=${heading.replace(/\s+/g, '-')}`;
  return vals.map((v) => ({ value: v, sourceUrl, sourceName: 'PubChem' }));
}

async function fetchPubchemExperimental(drugName) {
  // Lấy CID trước
  const cidData = await tryPubchem(`/rest/pug/compound/name/${encodeURIComponent(drugName)}/cids/JSON`);
  const cid = cidData?.IdentifierList?.CID?.[0];
  if (!cid) return { cid: null, data: {} };

  const compoundUrl = `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`;

  // Fetch nhiều sections song song (timeout ngắn để không block)
  const sections = {
    meltingPoint:   'Melting Point',
    boilingPoint:   'Boiling Point',
    solubility:     'Solubility',
    pka:            'Dissociation Constants',
    logP:           'LogP',
    density:        'Density',
    description:    'Physical Description',
    color:          'Color/Form',
    opticalRotation:'Optical Rotation',
    stability:      'Stability/Shelf Life',
  };

  const result = { cid, compoundUrl, data: {} };
  // Fetch tất cả 10 sections song song
  const keys = Object.keys(sections);
  const fetches = keys.map((k) => fetchPubchemSection(cid, sections[k]).then((v) => [k, v]));
  const resolved = await Promise.allSettled(fetches);
  for (const r of resolved) {
    if (r.status === 'fulfilled' && r.value[1].length) {
      result.data[r.value[0]] = r.value[1];
    }
  }
  return result;
}


async function fetchPdf(url) {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await pdfParse(res.data);
    return data.text.trim().slice(0, 15000);
  } catch (e) {
    return null;
  }
}

async function fetchSciHub(doiOrTitle) {
  try {
    const searchUrl = `https://sci-hub.se/${encodeURIComponent(doiOrTitle)}`;
    const res = await axios.get(searchUrl, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const cheerio = require('cheerio');
    const $ = cheerio.load(res.data);
    let pdfUrl = $('#pdf').attr('src');
    if (!pdfUrl) return null;
    if (pdfUrl.startsWith('//')) pdfUrl = 'https:' + pdfUrl;
    else if (pdfUrl.startsWith('/')) pdfUrl = 'https://sci-hub.se' + pdfUrl;
    
    return await fetchPdf(pdfUrl);
  } catch (e) {
    return null;
  }
}

async function fetchText(url, title = '') {
  try {
    if (url.toLowerCase().endsWith('.pdf') || url.includes('pdf')) {
      const pdfText = await fetchPdf(url);
      if (pdfText) return pdfText;
    }

    if (url.includes('pubmed.ncbi.nlm.nih.gov')) {
      const pmidMatch = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
      if (pmidMatch) {
        const pmid = pmidMatch[1];
        try {
          const pmRes = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
          const cheerio = require('cheerio');
          const $ = cheerio.load(pmRes.data);
          const doi = $('span.identifier.doi a').text().trim();
          
          if (doi) {
            const shText = await fetchSciHub(doi);
            if (shText) return shText;
          }
          
          const euRes = await axios.get(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=text&rettype=abstract`, { timeout: 8000 });
          return euRes.data.slice(0, 15000);
        } catch (e) { /* fallback */ }
      }
    }

    const res = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' },
    });
    
    let htmlText = String(res.data)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (htmlText.length < 2000) {
       const cheerio = require('cheerio');
       const $ = cheerio.load(res.data);
       let doi = $('meta[name="citation_doi"]').attr('content') || $('meta[name="dc.identifier"]').attr('content');
       if (!doi) {
         const doiMatch = String(res.data).match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
         if (doiMatch) doi = doiMatch[0];
       }
       if (doi) {
         const shText = await fetchSciHub(doi);
         if (shText) return shText;
       } else if (title) {
         const shText = await fetchSciHub(title);
         if (shText) return shText;
       }
    }

    if (url.includes('patents.google.com')) {
      const cheerio = require('cheerio');
      const $ = cheerio.load(res.data);
      const description = $('.description').text() || $('[itemprop="description"]').text() || $('section').text();
      const claims = $('.claims').text() || $('[itemprop="claims"]').text();
      const abstract = $('.abstract').text() || $('[itemprop="abstract"]').text();
      let patentText = `Abstract: ${abstract}\n\nClaims: ${claims}\n\nDescription: ${description}`;
      patentText = patentText.replace(/\s{2,}/g, ' ').trim();
      return patentText.slice(0, 30000);
    }

    return htmlText.slice(0, 15000);
  } catch { return null; }
}


async function callOpenAI(apiKey, messages, model = 'gpt-4o-mini', retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        { model, messages, temperature: 0.3, max_tokens: 4000 },
        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 90000 }
      );
      return res.data.choices[0].message.content;
    } catch (e) {
      if (i === retries - 1) throw e;
      console.error(`OpenAI error (${e.message}). Retrying ${i+1}/${retries}...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

async function callOpenAIVerified(apiKey, messages, model = 'gpt-4o-mini') {
  // Lần 1: Gọi bình thường để lấy bản nháp (Draft)
  const draftText = await callOpenAI(apiKey, messages, model);
  
  // Lần 2: Gọi AI thứ hai (Reviewer) để kiểm định chéo
  const verifyMessages = [
    { role: 'system', content: 'Bạn là chuyên gia kiểm định (AI Peer-Reviewer). Dưới đây là yêu cầu ban đầu, Dữ Liệu Gốc, và KẾT QUẢ BẢN NHÁP do một AI khác vừa phân tích.\nNhiệm vụ của bạn:\n1. Đối chiếu KẾT QUẢ BẢN NHÁP với Dữ Liệu Gốc và Yêu Cầu.\n2. Phát hiện và XÓA BỎ / SỬA LẠI bất kỳ thông tin nào bịa đặt (hallucination, không có trong dữ liệu gốc) hoặc suy diễn sai lệch. TUYỆT ĐỐI KHÔNG BỊA ĐẶT HOẶC SUY LUẬN. TẤT CẢ thông tin đưa ra mà có trích dẫn nguồn thì BẮT BUỘC thông tin đó phải có xuất xứ CHÍNH XÁC từ nguồn đó.\n3. Nếu JSON bị lỗi định dạng, hãy sửa lại cho đúng.\n4. Trả về đúng cấu trúc JSON mà người dùng yêu cầu ban đầu. KHÔNG giải thích, CHỈ trả về JSON hợp lệ.' },
    { role: 'user', content: `=== YÊU CẦU & DỮ LIỆU GỐC ===\n${messages.map(m => m.content).join('\n\n---\n\n')}\n\n=== KẾT QUẢ BẢN NHÁP CẦN KIỂM ĐỊNH ===\n${draftText}\n\n=== LỆNH CỦA REVIEWER ===\nHãy kiểm định, sửa lỗi (nếu có) và xuất ra JSON cuối cùng:` }
  ];
  return await callOpenAI(apiKey, verifyMessages, model);
}


async function serperSearch(query, apiKey, num = 10) {
  const res = await axios.post(
    'https://google.serper.dev/search',
    { q: query, num, hl: 'en', gl: 'us' },
    { headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

async function serperScholar(query, apiKey, num = 10) {
  const res = await axios.post(
    'https://google.serper.dev/scholar',
    { q: query, num },
    { headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

async function serperImageSearch(query, apiKey, num = 5) {
  const res = await axios.post(
    'https://google.serper.dev/images',
    { q: query, num, hl: 'en', gl: 'us' },
    { headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

function safeParseJSON(text) {
  const cleaned = text.replace(/^```(?:json)?\n?/gi, '').replace(/\n?```$/g, '').trim();
  return JSON.parse(cleaned);
}

// ── Route: Image proxy – dùng CDK Depict (simolecule.com) với SMILES ────────
// CDK Depict luôn hoạt động và không bị CORS. ChEMBL API /image trả 400.

app.get('/api/image/:chemblId', async (req, res) => {
  const smiles  = req.query.smiles || '';
  const chemblId = req.params.chemblId;

  // Ưu tiên: CDK Depict SVG (miễn phí, không cần auth, CORS-friendly)
  if (smiles) {
    try {
      const cdkUrl = `https://www.simolecule.com/cdkdepict/depict/bow/svg?smi=${encodeURIComponent(smiles)}&abbr=off&hdisp=bridgehead&showtitle=false&zoom=2.0&annotate=none`;
      const imgRes = await axios.get(cdkUrl, { responseType: 'arraybuffer', timeout: 12000 });
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=7200');
      return res.send(imgRes.data);
    } catch { /* thử ChEMBL */ }
  }

  // Fallback: ChEMBL PNG (có thể không được nhưng thử)
  try {
    const imgRes = await axios.get(
      `https://www.ebi.ac.uk/chembl/api/data/image/${chemblId}.svg`,
      { responseType: 'arraybuffer', timeout: 10000, headers: { Accept: 'image/svg+xml,image/*' } }
    );
    if (imgRes.status === 200) {
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(imgRes.data);
    }
  } catch { /* ignore */ }

  res.status(404).send('Image not available');
});

// ── Route: ChEMBL Properties ──────────────────────────────────────────────────

app.post('/api/properties', async (req, res) => {
  const { drugName } = req.body;
  if (!drugName) return res.status(400).json({ error: 'Thiếu tên hoạt chất' });

  try {
    const searchData = await get('https://www.ebi.ac.uk/chembl/api/data/molecule/search.json', {
      q: drugName, limit: 1,
    });
    const molecules = searchData.molecules || [];
    if (!molecules.length) return res.status(404).json({ error: `Không tìm thấy "${drugName}" trong ChEMBL` });

    const mol      = molecules[0];
    const chemblId = mol.molecule_chembl_id;
    const props    = mol.molecule_properties || {};
    const structs  = mol.molecule_structures || {};

    const [detailRes, mechRes] = await Promise.allSettled([
      get(`https://www.ebi.ac.uk/chembl/api/data/molecule/${chemblId}.json`),
      get('https://www.ebi.ac.uk/chembl/api/data/mechanism.json', { molecule_chembl_id: chemblId, limit: 5 }),
    ]);

    const detail     = detailRes.status === 'fulfilled' ? detailRes.value : mol;
    const mechanisms = mechRes.status === 'fulfilled' ? (mechRes.value.mechanisms || []) : [];

    const smiles = structs.canonical_smiles || '';

    res.json({
      chemblId,
      // Dùng endpoint proxy nội bộ thay vì URL ChEMBL trực tiếp (tránh CORS)
      imageUrl: `/api/image/${chemblId}?smiles=${encodeURIComponent(smiles)}`,
      prefName: mol.pref_name || drugName,
      moleculeType: mol.molecule_type,
      maxPhase:     mol.max_phase,
      properties: {
        IUPACName:          detail.iupac_name || mol.iupac_name,
        MolecularFormula:   props.full_molformula   || props.molecular_formula,
        MolecularWeight:    props.full_mwt          || props.mw_freebase,
        XLogP:              props.alogp             || props.cx_logp,
        TPSA:               props.psa,
        HBondDonorCount:    props.hbd,
        HBondAcceptorCount: props.hba,
        RotatableBondCount: props.rtb,
        Ro5Violations:      props.num_ro5_violations ?? props.ro5_violations,
        CanonicalSMILES:    smiles,
        InChIKey:           structs.standard_inchi_key,
      },
      experimental: {
        pka: [
          props.cx_most_apka ? `pKa (acid): ${props.cx_most_apka}` : null,
          props.cx_most_bpka ? `pKa (base): ${props.cx_most_bpka}` : null,
        ].filter(Boolean),
        logD:  props.cx_logd ? [`LogD (pH7.4): ${props.cx_logd}`] : [],
        logP:  props.cx_logp ? [`LogP: ${props.cx_logp}`]         : [],
        mp: [], sol: [], color: [],
      },
      mechanisms,
      synonyms: (detail.molecule_synonyms || mol.molecule_synonyms || [])
        .slice(0, 10).map((s) => s.molecule_synonym),
      sources: {
        chembl: `https://www.ebi.ac.uk/chembl/compound_report_card/${chemblId}/`,
        chemblApi: `https://www.ebi.ac.uk/chembl/api/data/molecule/${chemblId}.json`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route: AI Analysis – dữ liệu xác minh + trích dẫn nghiêm ngặt ─────────────

app.post('/api/ai-analysis', async (req, res) => {
  const { drugName, drugData, openaiKey, serperKey } = req.body;
  if (!openaiKey) return res.status(400).json({ error: 'Thiếu OpenAI API key' });

  try {
    // ── Lấy dữ liệu thực từ PubChem (song song với ChEMBL) ──────────────────
    const pubchem = await fetchPubchemExperimental(drugName);
    const pc      = pubchem.data;
    const cid     = pubchem.cid;
    const chemblId = drugData?.chemblId || '';

    let dbSnippets = '';
    let polymorphSnippets = '';
    let bcsSnippets = '';
    let polymorphImage = '';
    if (serperKey) {
      try {
        const [dbRes, polyRes, bcsRes, imgRes] = await Promise.all([
          serperSearch(`site:go.drugbank.com/drugs "${drugName}" properties OR half-life OR mechanism OR absorption`, serperKey, 5),
          serperSearch(`${drugName} Polymorphism`, serperKey, 5),
          serperSearch(`${drugName} BCS classification`, serperKey, 3),
          serperImageSearch(`${drugName} polymorphism crystal morphology`, serperKey, 3)
        ]);
        if (dbRes.organic && dbRes.organic.length > 0) {
          dbSnippets = dbRes.organic.map(r => `Nguồn: ${r.link}\nTrích đoạn: ${r.snippet}`).join('\n\n');
        }
        if (polyRes.organic && polyRes.organic.length > 0) {
          polymorphSnippets = polyRes.organic.map(r => `Nguồn: ${r.link}\nTiêu đề: ${r.title}\nTrích đoạn: ${r.snippet}`).join('\n\n');
        }
        if (bcsRes.organic && bcsRes.organic.length > 0) {
          bcsSnippets = bcsRes.organic.map(r => `Nguồn: ${r.link}\nTrích đoạn: ${r.snippet}`).join('\n\n');
        }
        if (imgRes.images && imgRes.images.length > 0) {
          polymorphImage = imgRes.images[0].imageUrl;
        }
      } catch (e) { console.error('Serper search error:', e.message); }
    }

    // Tóm tắt dữ liệu xác minh đã có để gửi cho AI
    const verifiedFacts = [];
    const chemblUrl = `https://www.ebi.ac.uk/chembl/compound_report_card/${chemblId}/`;

    // ChEMBL properties
    const p = drugData?.properties || {};
    if (p.MolecularWeight) verifiedFacts.push({ fact: `Phân tử lượng: ${p.MolecularWeight} g/mol`, source: chemblUrl, db: 'ChEMBL' });
    if (p.MolecularFormula) verifiedFacts.push({ fact: `CTPT: ${p.MolecularFormula}`, source: chemblUrl, db: 'ChEMBL' });
    if (p.XLogP) verifiedFacts.push({ fact: `LogP (ALogP): ${p.XLogP}`, source: chemblUrl, db: 'ChEMBL' });
    if (p.TPSA) verifiedFacts.push({ fact: `TPSA: ${p.TPSA} Å²`, source: chemblUrl, db: 'ChEMBL' });

    // PubChem experimental
    const pcUrl = cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}` : null;
    for (const [key, items] of Object.entries(pc)) {
      for (const item of items) {
        verifiedFacts.push({ fact: `${key}: ${item.value}`, source: item.sourceUrl, db: 'PubChem' });
      }
    }

    const verifiedText = verifiedFacts.map((f, i) =>
      `[V${i + 1}] ${f.fact} — Nguồn: ${f.db} (${f.source})`
    ).join('\n');

    // ── AI Analysis với yêu cầu trích dẫn nghiêm ngặt ──────────────────────
    const text = await callOpenAIVerified(openaiKey, [
      {
        role: 'system',
        content: `Bạn là dược sĩ chuyên gia phân tích dược chất. 

QUY TẮC NGHIÊM NGẶT:
1. ĐỐI VỚI CÁC THÔNG SỐ VẬT LÝ (Nhiệt độ nóng chảy, pKa, Phân tử lượng, LogP, TPSA): TUYỆT ĐỐI CHỈ SỬ DỤNG DỮ LIỆU ĐƯỢC CUNG CẤP TRONG MỤC [V1..Vn]. Giữ nguyên chính xác giá trị số (không làm tròn, không tự biên tập lại khoảng nhiệt độ). NẾU KHÔNG CÓ TRONG [V1..Vn], HÃY GHI "Không có dữ liệu". KHÔNG dùng kiến thức nội bộ.
2. Mỗi thông tin PHẢI kèm URL nguồn cụ thể trong trường "sourceUrl" (lấy URL tương ứng với thông tin đó từ [V1..Vn]).
3. Đối với các dữ liệu bổ sung (như cơ chế, BCS): Ưu tiên lấy từ DỮ LIỆU BỔ SUNG TỪ DRUGBANK và ĐIỀN CHÍNH XÁC đường link nguồn. TUYỆT ĐỐI KHÔNG ĐỂ sourceUrl LÀ null.
4. Với polymorph: chỉ mô tả các dạng đã được công bố, ghi rõ DOI (https://doi.org/...) hoặc URL cụ thể.
5. TUYỆT ĐỐI KHÔNG BỊA ĐẶT HOẶC SUY LUẬN. TẤT CẢ thông tin đưa ra mà có trích dẫn nguồn thì BẮT BUỘC thông tin đó phải có xuất xứ CHÍNH XÁC từ nguồn đó.
6. Trả lời bằng tiếng Việt. JSON hợp lệ KHÔNG có markdown.`,
      },
      {
        role: 'user',
        content: `Phân tích dược chất "${drugName}".

DỮ LIỆU ĐÃ XÁC MINH TỪ API (sử dụng trực tiếp, không thay đổi giá trị):
${verifiedText || '(Không lấy được từ API)'}

DỮ LIỆU BỔ SUNG TỪ DRUGBANK (Google Search):
${dbSnippets || '(Không có dữ liệu DrugBank)'}

DỮ LIỆU THÙ HÌNH TINH THỂ (Polymorphism Search):
${polymorphSnippets || '(Không có dữ liệu thù hình)'}

DỮ LIỆU BCS (Google Search):
${bcsSnippets || '(Không có dữ liệu BCS)'}

ChEMBL ID: ${chemblId} — ${chemblUrl}
${cid ? `PubChem CID: ${cid} — ${pcUrl}` : ''}
DrugBank: https://www.drugbank.ca/unearth/q?query=${encodeURIComponent(drugName)}&searcher=drugs

Trả về JSON (mỗi field có value + sourceUrl):
{
  "structure": {
    "description": "Mô tả cấu trúc",
    "sourceUrl": "URL ChEMBL hoặc PubChem",
    "functionalGroups": [{"group": "Tên nhóm chức", "role": "Vai trò dược lý"}],
    "stereochemistry": "Mô tả lập thể",
    "stereochemistrySource": "URL nguồn",
    "pharmacophore": "Mô tả dược đoàn",
    "pharmacophoreSource": "URL nguồn"
  },
  "physical": {
    "appearance": {"value": "Mô tả cảm quan", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Physical-Description` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"},
    "meltingPoint": {"value": "Nhiệt độ °C", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Melting-Point` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"},
    "boilingPoint": {"value": "°C", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Boiling-Point` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"},
    "solubility": {"value": "mg/mL hoặc g/L trong nước, ethanol...", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Solubility` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"},
    "density": {"value": "g/cm³", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Density` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"},
    "polymorphs": {
      "overview": "Tổng quan: Có bao nhiêu dạng thù hình? Đặc điểm chung.",
      "forms": [
        {
          "name": "Tên dạng (Ví dụ: Form I, Form II)",
          "characteristics": "Đặc điểm tinh thể, độ hòa tan, độ bền",
          "differences": "Điểm khác biệt so với các dạng khác"
        }
      ],
      "commercialForm": "Dạng nào bền nhất và phổ biến nhất trong dược phẩm?",
      "morphology": "Mô tả hình dạng tiểu phân (morphology) của dạng thương mại hoặc dạng tinh thể chính (ví dụ: hình kim, hình phiến, hạt, khối...)",
      "imageUrl": "${polymorphImage}",
      "sourceUrl": "Mã DOI của bài báo (Ví dụ: 10.1016/j.xphs...)",
      "paperTitle": "Tên bài báo khoa học"
    }
  },
  "chemical": {
    "acidBaseNature": {"value": "Suy luận tính Acid/Base dựa vào pKa và cấu trúc hóa học, chỉ rõ nhóm chức nào gây ra tính acid hoặc base", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Dissociation-Constants` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"},
    "pka": {"value": "Giá trị pKa", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Dissociation-Constants` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"},
    "stabilityOverview": {"value": "Tổng quan độ ổn định", "sourceUrl": "https://go.drugbank.com/unearth/q?query=${encodeURIComponent(drugName)}+stability"}
  },
  "biological": {
    "logP": {"value": "Giá trị LogP lấy từ PubChem", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Octanol-Water-Partition-Coefficient` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"},
    "bcsClass": {"value": "Phân loại BCS Class I/II/III/IV dựa trên DỮ LIỆU BCS", "sourceUrl": "Mã DOI hoặc URL từ bài báo trong DỮ LIỆU BCS"}
  },
  "_verifiedData": ${JSON.stringify(pc)},
  "_chemblId": "${chemblId}",
  "_pubchemCid": ${cid || null}
}`,
      },
    ]);

    try {
      const parsed = safeParseJSON(text);
      // Đảm bảo dữ liệu PubChem thực được đính kèm
      parsed._pubchemCid      = cid;
      parsed._pubchemRawData  = pc;
      parsed._chemblId        = chemblId;
      parsed._pubchemUrl      = pcUrl;
      parsed._chemblUrl       = chemblUrl;
      parsed._verifiedFacts   = verifiedFacts;
      res.json(parsed);
    } catch {
      res.json({ raw: text, _pubchemCid: cid, _pubchemRawData: pc });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route: Forced Degradation (Semantic Scholar + Serper + OpenAI) ────────────


app.post('/api/forced-degradation', async (req, res) => {
  const { drugName, openaiKey, serperKey } = req.body;
  if (!openaiKey) return res.status(400).json({ error: 'Thiếu OpenAI API key' });

  try {
    let papers     = [];   // {title, url, abstract, year, authors, body, source}
    let searchMode = 'ai-knowledge';

    if (serperKey) {
      try {
        const [rawRes, phRes, ncbiRes, pdfRes, degRes, scholarRes] = await Promise.allSettled([
          serperSearch(`${drugName} forced degradation`, serperKey, 40),
          serperSearch(`${drugName} stability pH range`, serperKey, 20),
          serperSearch(`site:ncbi.nlm.nih.gov ${drugName} forced degradation`, serperKey, 20),
          serperSearch(`${drugName} forced degradation filetype:pdf`, serperKey, 20),
          serperSearch(`${drugName} forced degradation impurity mechanism`, serperKey, 5),
          serperScholar(`${drugName} forced degradation`, serperKey, 10)
        ]);

        const organicRaw = rawRes.status === 'fulfilled' ? rawRes.value.organic || [] : [];
        const organicDeg = degRes.status === 'fulfilled' ? degRes.value.organic || [] : [];
        const organicPh  = phRes.status === 'fulfilled' ? phRes.value.organic || [] : [];
        const organicNcbi = ncbiRes.status === 'fulfilled' ? ncbiRes.value.organic || [] : [];
        const organicPdf = pdfRes.status === 'fulfilled' ? pdfRes.value.organic || [] : [];
        const organicScholar = scholarRes.status === 'fulfilled' ? scholarRes.value.organic || [] : [];

        // Gộp kết quả
        const uniqueLinks = new Set();
        const combined = [];
        
        for (const r of [...organicRaw, ...organicScholar, ...organicNcbi, ...organicPdf, ...organicPh, ...organicDeg]) {
          if (r.link && !uniqueLinks.has(r.link)) {
            uniqueLinks.add(r.link);
            combined.push(r);
          }
        }

        // LOG TO FILE FOR DEBUGGING
        const fs = require('fs');
        const logContent = combined.map(r => r.title + ' -> ' + r.link).join('\n');
        fs.writeFileSync('serper_debug.log', `=== SERPER COMBINED RESULTS ===\n${logContent}\n`);

        const chunkSize = 5;
        for (let i = 0; i < combined.length; i += chunkSize) {
          const chunk = combined.slice(i, i + chunkSize);
          await Promise.all(chunk.map(async (r) => {
            let body = '';
            try {
              body = await fetchText(r.link, r.title) || '';
            } catch (e) {
              console.error(`Không thể đọc nội dung URL ${r.link}:`, e.message);
            }
            
            let doi = '';
            const urlDoiMatch = r.link.match(/10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+/);
            if (urlDoiMatch) doi = urlDoiMatch[0];
            else if (body) {
              const bodyDoiMatch = body.match(/10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+/);
              if (bodyDoiMatch) doi = bodyDoiMatch[0];
            }

            papers.push({
              title:    r.title,
              url:      r.link,
              doi:      doi,
              abstract: r.snippet || '',
              year:     null,
              authors:  '',
              body:     body,
              source:   'Google Search',
            });
          }));
          await delay(300);
        }
        if (papers.length > 0) searchMode = 'google-search';
      } catch (e) {
        console.error('Serper error:', e.message);
      }
    }

    // Ưu tiên các bài báo chất lượng cao (NCBI, PDF, pubmed, PMC) lên đầu để đưa vào AI
    const sortedPapers = [...papers].sort((a, b) => {
      const score = (p) => (p.url.includes('ncbi.nlm.nih.gov') ? 3 : 0) + (p.url.includes('.pdf') ? 2 : 0) + (p.url.includes('aws') ? 1 : 0);
      return score(b) - score(a);
    });

    const aiPapers = sortedPapers.slice(0, 20);

    const paperContext = aiPapers.length
      ? aiPapers.map((p, i) => `[Tài liệu ${i + 1}]
Tiêu đề: ${p.title}
Nguồn: ${p.url}
Abstract/Snippet: ${p.abstract.slice(0, 1000)}
Nội dung chính: ${p.body.slice(0, 7000)}`).join('\n\n---\n\n')
      : '';

    const systemMsg = `Bạn là một trợ lý tra cứu dữ liệu khoa học thực nghiệm. Bạn KHÔNG ĐƯỢC PHÉP sử dụng kiến thức có sẵn trong bộ nhớ để tự suy đoán hoặc giải thích.
BƯỚC 1: SÀNG LỌC VÀ ĐỐI CHIẾU DỮ LIỆU
- Kiểm tra xem tài liệu được cung cấp có thực sự nghiên cứu về hoạt chất mục tiêu hay không. NẾU KHÔNG, LOẠI BỎ NGAY.
- Đọc kết quả từ các nguồn tài liệu. Chỉ giữ lại các thông số thực nghiệm RÕ RÀNG: nồng độ chất thử (VD: HCl 1M), nhiệt độ (VD: 60°C), thời gian, và tên tạp chất/sản phẩm phân hủy thực tế.
- Nếu tài liệu không có thông tin về một điều kiện cụ thể, hãy ghi rõ: "Không tìm thấy dữ liệu thực nghiệm công bố cho điều kiện này". Tuyệt đối không tự điền thông tin lý thuyết.
BƯỚC 2: TRÍCH XUẤT VÀ ĐÍNH KÈM NGUỒN
Trình bày kết quả theo đúng cấu trúc JSON được yêu cầu. Mọi thông tin BẮT BUỘC phải có nguồn gốc từ tài liệu.`;

    const userMsg = papers.length
      ? `Đọc toàn bộ các tài liệu liên quan dưới đây về pH ổn định và phân hủy cưỡng bức của "${drugName}" (LƯU Ý: Chú ý ĐÀO THẢI những bài báo không tập trung vào ${drugName}):\n\n${paperContext}\n\nLập báo cáo. MỖI điều kiện cần ghi rõ Thông số thực nghiệm, Kết quả thu được và Nguồn trích dẫn. Trả về JSON:`
      : `Dựa trên tài liệu (nếu có), hãy cung cấp dữ liệu thực nghiệm về độ ổn định của "${drugName}". Tuyệt đối không suy đoán lý thuyết. Trả về JSON:`;

    const template = `{
  "overview": "Tổng quan độ ổn định",
  "acidDegradation": {
    "conditions": "Thông số thực nghiệm: Nồng độ, nhiệt độ, thời gian...",
    "rate": "Kết quả: % phân hủy",
    "products": "Sản phẩm phân hủy chính thu được (hoặc cơ chế nếu có báo cáo thực nghiệm)",
    "mechanism": "",
    "reference": "Tên bài báo khoa học - Mã DOI: (Ví dụ: 10...)",
    "quote": "Trích dẫn nguyên văn văn bản từ bài báo"
  },
  "alkalineDegradation": {
    "conditions": "", "rate": "", "products": "", "mechanism": "",
    "reference": "Tên bài báo khoa học - Mã DOI: (Ví dụ: 10...)", "quote": ""
  },
  "oxidativeDegradation": {
    "conditions": "", "rate": "", "products": "", "mechanism": "",
    "reference": "Tên bài báo khoa học - Mã DOI: (Ví dụ: 10...)", "quote": ""
  },
  "thermalDegradation": {
    "conditions": "", "rate": "", "products": "", "mechanism": "",
    "reference": "Tên bài báo khoa học - Mã DOI: (Ví dụ: 10...)", "quote": ""
  },
  "photoDegradation": {
    "conditions": "", "rate": "", "products": "", "mechanism": "",
    "reference": "Tên bài báo khoa học - Mã DOI: (Ví dụ: 10...)", "quote": ""
  },
  "hydrolysisDegradation": {
    "conditions": "", "rate": "", "products": "", "mechanism": "",
    "reference": "Tên bài báo khoa học - Mã DOI: (Ví dụ: 10...)", "quote": ""
  },
  "mainDegradationProducts": ["SP1 + mô tả", "SP2"],
  "analyticMethod": "HPLC-UV / LC-MS/MS: điều kiện cột, pha động (nếu có)",
  "conclusion": "Thứ tự nhạy cảm → khuyến nghị bảo quản",
  "citedUrls": ["URL của các bài báo mà bạn đã trích dẫn trong phần kết quả ở trên"],
  "papers": [
    {
      "title": "Tiêu đề tài liệu",
      "authors": "Tác giả (nếu có)",
      "year": "Năm (nếu có)",
      "journal": "Nguồn",
      "url": "URL/DOI",
      "source": "Google"
    }
  ],
  "dataSource": "${searchMode}"
}`;

    const phSystemMsg = `Bạn là một chuyên gia hóa dược. Dựa trên kiến thức chuyên môn nội bộ của bạn, hãy trả lời về dải pH ổn định (stable pH range) của hoạt chất.
TUYỆT ĐỐI không nhầm lẫn dải pH ổn định với giá trị pKa.
BẮT BUỘC phải trích dẫn tên tài liệu hoặc nguồn tham khảo khoa học mà bạn đã học được. Trả về định dạng JSON hợp lệ KHÔNG dùng markdown.`;
    const phUserMsg = `Cung cấp dải pH ổn định của hoạt chất "${drugName}".
Trình bày theo cấu trúc JSON:
{
  "range": "Khoảng pH ổn định",
  "details": "Giải thích chi tiết",
  "reference": "Nguồn tài liệu trích dẫn (Tên bài báo khoa học, sách chuyên ngành, tài liệu tham khảo)",
  "quote": "Trích dẫn nguyên văn (nếu có)"
}`;

    const [text, phText] = await Promise.all([
      callOpenAIVerified(openaiKey, [
        { role: 'system', content: systemMsg },
        { role: 'user',   content: `${userMsg}\n${template}` },
      ]),
      callOpenAIVerified(openaiKey, [
        { role: 'system', content: phSystemMsg },
        { role: 'user',   content: phUserMsg }
      ])
    ]);

    try {
      const parsed       = safeParseJSON(text);
      let phParsed       = null;
      try { phParsed = safeParseJSON(phText); } catch(e) {}
      
      if (phParsed && phParsed.range) {
        parsed.stablePhRange = phParsed;
      }
      
      parsed.rawPapers   = papers.map((p) => ({ title: p.title, url: p.url, doi: p.doi, year: p.year, authors: p.authors, source: p.source, hasBody: p.body && p.body.length > 500 }));
      parsed.searchMode  = searchMode;
      res.json(parsed);
    } catch {
      res.json({ raw: text, rawPapers: papers.map((p) => ({ title: p.title, url: p.url, doi: p.doi, year: p.year, authors: p.authors, source: p.source, hasBody: p.body && p.body.length > 500 })), searchMode });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route: Vidal.ru Formulas (Thay thế SRA) ───────────────────────────────────────────────

app.post('/api/sra-formulas', async (req, res) => {
  const { drugName, dosageForm, openaiKey } = req.body;
  if (!drugName || !dosageForm) return res.status(400).json({ error: 'Thiếu tên hoạt chất hoặc dạng bào chế' });
  if (!openaiKey) return res.status(400).json({ error: 'Thiếu OpenAI API key' });

  try {
    const cheerio = require('cheerio');
    // 1. Tìm kiếm trên Vidal.ru
    const searchUrl = `https://www.vidal.ru/search?q=${encodeURIComponent(drugName)}`;
    const searchRes = await axios.get(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });
    
    const $ = cheerio.load(searchRes.data);
    const links = [];
    $('.products-table-name a').each((i, el) => {
      links.push({
        title: $(el).text().trim(),
        url: 'https://www.vidal.ru' + $(el).attr('href')
      });
    });

    if (links.length === 0) {
      return res.json({ products: [], totalProducts: 0, dataSource: 'Vidal.ru (Nga)' });
    }

    // 2. Lấy dữ liệu chi tiết (tất cả sản phẩm) với concurrency limit
    const productData = [];
    const chunkSize = 5; // Xử lý 5 request cùng lúc để tránh nghẽn
    const chunks = [];
    for (let i = 0; i < links.length; i += chunkSize) {
      chunks.push(links.slice(i, i + chunkSize));
    }

    for (const chunk of chunks) {
      await Promise.all(chunk.map(async (link) => {
        try {
          const detailRes = await axios.get(link.url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
          });
          const $d = cheerio.load(detailRes.data);
          let composition = '';
          $d('.block').each((i, el) => {
            const blockTitle = $d(el).find('h2').text().trim() || $d(el).find('.block-title').text().trim();
            if (blockTitle.toLowerCase().includes('состав') || blockTitle.toLowerCase().includes('композиция')) {
                 composition = $d(el).text().trim().replace(/\s+/g, ' ').substring(0, 3000);
            }
          });
          if (composition) {
            productData.push({ title: link.title, url: link.url, text: composition });
          }
        } catch (e) {
          console.error('Error fetching vidal product:', link.url, e.message);
        }
      }));
      await delay(300); // Nghỉ 300ms sau mỗi batch
    }

    // 3. Sử dụng AI để dịch và lọc theo dạng bào chế
    const promptData = productData.map((p, i) => `[Sản phẩm ${i + 1}]\nTên: ${p.title}\nURL: ${p.url}\nThành phần (Tiếng Nga): ${p.text}`).join('\n\n');
    
    const aiSystem = `Bạn là chuyên gia bào chế và phiên dịch Dược phẩm Nga. Nhiệm vụ:
1. Đọc các bản ghi thành phần từ Vidal.ru.
2. LỌC: CHỈ giữ lại các sản phẩm khớp với dạng bào chế mục tiêu (ví dụ: "Tablet" tương đương "таблетки", "Capsule" tương đương "капсулы"). Bỏ qua các sản phẩm không khớp.
3. DỊCH TOÀN BỘ TÊN THÀNH PHẦN SANG TIẾNG VIỆT: 
   - Dịch tên Hoạt chất (activeIngredient) sang tiếng Việt.
   - Dịch TẤT CẢ các thành phần tá dược (вспомогательные вещества) sang tiếng Việt, PHẢI GIỮ NGUYÊN HÀM LƯỢNG VÀ SỐ LƯỢNG (nếu có). 
Ví dụ: "cellulose vi tinh thể (MCC-101 Premium) - 25,5 mg". 
Nếu tiếng Nga có ghi hàm lượng thì TUYỆT ĐỐI không được bỏ đi.
4. TỔNG HỢP & ĐỀ XUẤT:
   - "commonExcipients": Liệt kê các tá dược được dùng phổ biến nhất trong các công thức trên.
   - "formulationInsights": Viết một đoạn văn ngắn gọn đề xuất một công thức tối ưu nhất dựa trên dữ liệu thu thập được.
5. YÊU CẦU BẮT BUỘC (CRITICAL): BẠN PHẢI TRẢ VỀ TOÀN BỘ TẤT CẢ CÁC SẢN PHẨM KHỚP VỚI DẠNG BÀO CHẾ. TUYỆT ĐỐI KHÔNG ĐƯỢC LƯỢC BỎ, RÚT GỌN, HAY CHỈ LẤY VÍ DỤ! NẾU CÓ 50 SẢN PHẨM KHỚP, BẠN PHẢI TRẢ VỀ ĐỦ 50 SẢN PHẨM TRONG MẢNG "products".
6. TUYỆT ĐỐI KHÔNG BỊA ĐẶT HOẶC SUY LUẬN.
7. TRẢ VỀ JSON hợp lệ KHÔNG dùng markdown.
Cấu trúc JSON:
{
  "products": [
    {
      "productName": "Tên sản phẩm tiếng Nga",
      "manufacturer": "N/A",
      "country": "Nga",
      "dosageForm": "Dạng bào chế (tiếng Việt/Anh)",
      "strength": "Hàm lượng (nếu có)",
      "activeIngredient": "Tên hoạt chất (Đã dịch sang tiếng Việt)",
      "excipients": ["Tá dược 1 - x mg (Đã dịch sang tiếng Việt)", "Tá dược 2 - y mg (Đã dịch sang tiếng Việt)"],
      "manufacturingProcess": "Đề xuất quy trình bào chế chi tiết và phù hợp nhất dựa trên các tá dược hiện có VÀ DẠNG BÀO CHẾ MỤC TIÊU (ví dụ: nếu là Viên nén thì đề xuất xát hạt ướt, dập thẳng...; nếu là Kem/Mỡ thì đề xuất nhũ hóa... kèm các bước cơ bản)",
      "route": "Đường dùng",
      "source": "Vidal.ru",
      "sourceUrl": "URL gốc"
    }
  ],
  "commonExcipients": ["Tá dược A", "Tá dược B"],
  "formulationInsights": "Đoạn văn nhận xét và đề xuất công thức..."
}`;

    const text = await callOpenAI(openaiKey, [
      { role: 'system', content: aiSystem },
      { role: 'user', content: `Hoạt chất mục tiêu: ${drugName}\nDạng bào chế mục tiêu: ${dosageForm}\n\nDữ liệu tiếng Nga:\n${promptData}\n\nHãy xuất JSON:` }
    ]);

    let parsed = { products: [] };
    try {
      parsed = safeParseJSON(text);
    } catch {
      console.error('Lỗi parse JSON từ AI');
    }

    res.json({
      products: parsed.products || [],
      totalProducts: (parsed.products || []).length,
      dataSource: 'Vidal.ru (Nga)',
      commonExcipients: parsed.commonExcipients || [],
      formulationInsights: parsed.formulationInsights || ''
    });
  } catch (err) {
    console.error('Vidal Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: Patents ────────────────────────────────────────────────────────────

app.post('/api/patents', async (req, res) => {
  const { drugName, dosageForm, openaiKey, serperKey } = req.body;
  if (!openaiKey || !serperKey) return res.status(400).json({ error: 'Thiếu API key' });

  try {
    const q = `"${drugName}"${dosageForm ? ` "${dosageForm}"` : ''} patent`;
    const [gPat, gen] = await Promise.allSettled([
      serperSearch(`site:patents.google.com ${q}`, serperKey, 20),
      serperSearch(`${q} site:patents.google.com OR site:worldwide.espacenet.com`, serperKey, 10),
    ]);

    const organic = [
      ...((gPat.status === 'fulfilled' ? gPat.value.organic : []) || []),
      ...((gen.status  === 'fulfilled' ? gen.value.organic  : []) || []),
    ];
    const seen = new Set();
    const unique = organic.filter((r) => { if (seen.has(r.link)) return false; seen.add(r.link); return true; });

    const docs = [];
    for (const p of unique.slice(0, 15)) {
      await delay(200);
      const body = await fetchText(p.link);
      docs.push({ title: p.title, url: p.link, snippet: p.snippet, body: body || '' });
    }

    const text = await callOpenAI(openaiKey, [
      { role: 'system', content: 'Bạn là chuyên gia phân tích patent dược phẩm.\nNhiệm vụ:\n0. LỌC NGHIÊM NGẶT: Chỉ trích xuất các patent có nội dung CHÍNH xác với dạng bào chế được yêu cầu. NẾU BÀI BÁO NÓI VỀ DẠNG BÀO CHẾ KHÁC (VD: Yêu cầu Capsule nhưng patent là Tablet), BỎ QUA NGAY LẬP TỨC.\n1. TÓM TẮT CHUYÊN SÂU CÁC VÍ DỤ (EXAMPLES): Phải đọc sâu vào phần Examples của patent để lấy ra các thông số thử nghiệm cụ thể.\n2. LÝ DO CHỌN CÔNG THỨC: Phân tích thật kỹ tiêu chí/phương pháp đánh giá (độ hòa tan, độ cứng, độ ổn định...) dẫn đến việc tác giả chọn công thức ưu việt nhất.\n3. TRÍCH XUẤT CÔNG THỨC TỐI ƯU NHẤT (Preferred Embodiment) dưới dạng danh sách (bullet points) kèm hàm lượng/tỷ lệ cụ thể.\n4. Trích xuất QUY TRÌNH BÀO CHẾ chi tiết từng bước (step-by-step), bao gồm các thông số kỹ thuật (nhiệt độ, thời gian...).\n5. Ghi rõ số patent và URL. TUYỆT ĐỐI KHÔNG BỊA ĐẶT HOẶC SUY LUẬN. TẤT CẢ thông tin đưa ra mà có trích dẫn nguồn thì BẮT BUỘC thông tin đó phải có xuất xứ CHÍNH XÁC từ nguồn đó.\n6. Trả lời bằng tiếng Việt. JSON hợp lệ KHÔNG có markdown.' },
      {
        role: 'user',
        content: `Đọc và phân tích CHUYÊN SÂU các patent của "${drugName}"${dosageForm ? ` ĐẶC BIỆT CHỈ LỌC DẠNG BÀO CHẾ: "${dosageForm}"` : ''}:\n\n${docs.map((p, i) => `[Patent ${i + 1}]\nTiêu đề: ${p.title}\nURL: ${p.url}\nNội dung: ${p.body.slice(0, 20000)}`).join('\n\n---\n\n')}\n\nJSON:
{
  "patents": [{
    "patentNumber": "US/EP/WO số...",
    "title": "Tiêu đề",
    "applicant": "Công ty",
    "filingDate": "Ngày nộp",
    "url": "URL",
    "dosageForm": "Dạng bào chế",
    "composition": {
      "activeIngredient": "Hoạt chất + hàm lượng",
      "excipients": ["Tá dược + lượng/vai trò"],
      "examplesSummary": "Tóm tắt các công thức trong phần Ví dụ (Examples).",
      "selectionMethod": "Phương pháp/tiêu chí đánh giá để chọn công thức tối ưu (đo độ hòa tan, độ cứng, v.v.).",
      "optimalFormula": "- Hoạt chất X: 100mg\n- Tá dược Y: 50mg\n...",
      "manufacturingProcess": "1. Bước 1: Trộn...\n2. Bước 2: Sấy ở nhiệt độ...\n3. Bước 3: ...",
      "innovativeFeatures": "Điểm đổi mới"
    },
    "claims": "Claims chính"
  }],
  "formulationTrends": "Xu hướng công thức",
  "keyExcipients": ["Tá dược đặc trưng"],
  "patentLandscape": "Tổng quan patent"
}`
      }
    ]);

    try {
      const parsed    = safeParseJSON(text);
      parsed.rawLinks = unique.map((r) => ({ title: r.title, url: r.link, snippet: r.snippet }));
      res.json(parsed);
    } catch { res.json({ raw: text, rawLinks: unique }); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`\n🔬 Drug Research Pro đang chạy tại http://localhost:${PORT}`);
});
server.setTimeout(300000); // 5 minutes
