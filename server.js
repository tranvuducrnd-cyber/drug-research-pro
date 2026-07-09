require('dotenv').config({ path: require('path').resolve(__dirname, '.env'), override: true });
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const { PDFParse } = require('pdf-parse');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  if (req.method === 'POST') {
    console.log(`[REQUEST] ${req.method} ${req.url} - body:`, JSON.stringify(req.body).substring(0, 300));
  } else {
    console.log(`[REQUEST] ${req.method} ${req.url}`);
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/diag', async (req, res) => {
  const openaiKey = process.env.OPENAI_API_KEY || '';
  const serperKey = process.env.SERPER_API_KEY || '';
  
  const diag = {
    dotenvLoaded: !!openaiKey,
    openaiKeyLength: openaiKey.length,
    openaiKeySnippet: openaiKey ? (openaiKey.substring(0, 10) + '...' + openaiKey.substring(openaiKey.length - 4)) : 'none',
    serperKeyLength: serperKey.length,
    openaiTest: 'not_run'
  };

  if (openaiKey) {
    try {
      await callOpenAI(openaiKey, [{ role: 'user', content: 'hello' }], 'gpt-4o-mini', 1);
      diag.openaiTest = 'SUCCESS';
    } catch (e) {
      diag.openaiTest = `FAILED: ${e.message}`;
    }
  }

  res.json(diag);
});

const progressStore = {};

function updateProgress(searchId, step, percent, message) {
  if (!searchId) return;
  if (!progressStore[searchId]) {
    progressStore[searchId] = {};
  }
  progressStore[searchId][step] = { percent, message };
}

app.get('/api/progress', (req, res) => {
  const { id } = req.query;
  res.json(progressStore[id] || {});
});

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

async function tryPubchem(urlPath, params = {}, timeoutMs = 15000) {
  try {
    return await get(`https://pubchem.ncbi.nlm.nih.gov${urlPath}`, params, timeoutMs);
  } catch (err) {
    console.error(`PubChem API error (${urlPath}):`, err.message);
    return null;
  }
}

function findSection(arr, heading) {
  for (const item of arr || []) {
    if (item.TOCHeading === heading) return item;
    if (item.Section) {
      const found = findSection(item.Section, heading);
      if (found) return found;
    }
  }
  return null;
}

function extractPubchemValues(section) {
  if (!section) return [];
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
  if (section.Information) {
    dig([section]);
  } else if (section.Section) {
    dig(section.Section);
  }
  return vals.slice(0, 5);
}

async function fetchPubchemExperimental(drugName) {
  // Lấy CID trước
  const cidData = await tryPubchem(`/rest/pug/compound/name/${encodeURIComponent(drugName)}/cids/JSON`);
  const cid = cidData?.IdentifierList?.CID?.[0];
  if (!cid) return { cid: null, data: {} };

  const compoundUrl = `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`;
  
  // Tải toàn bộ record của compound chỉ bằng 1 request
  const fullData = await tryPubchem(`/rest/pug_view/data/compound/${cid}/JSON`, {}, 20000);
  if (!fullData || !fullData.Record || !fullData.Record.Section) {
    return { cid, compoundUrl, data: {} };
  }

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
  const rootSections = fullData.Record.Section;

  for (const [key, heading] of Object.entries(sections)) {
    const sec = findSection(rootSections, heading);
    if (sec) {
      const vals = extractPubchemValues(sec);
      if (vals.length) {
        const sourceUrl = `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=${heading.replace(/\s+/g, '-')}`;
        result.data[key] = vals.map((v) => ({ value: v, sourceUrl, sourceName: 'PubChem' }));
      }
    }
  }

  return result;
}


function getGoogleDriveDownloadUrl(url) {
  if (!url) return null;
  const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return `https://drive.google.com/uc?export=download&id=${match[1]}`;
  }
  return url;
}

async function fetchPdf(url) {
  try {
    const downloadUrl = getGoogleDriveDownloadUrl(url);
    const res = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const uint8 = new Uint8Array(res.data);
    const parser = new PDFParse(uint8);
    const data = await parser.getText();
    return data.text.trim().slice(0, 20000); // Tăng giới hạn ký tự lên 20k ký tự để lấy nhiều thông tin hơn
  } catch (e) {
    console.error('[fetchPdf error]', e.message);
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
  const { drugName, searchId } = req.body;
  if (!drugName) return res.status(400).json({ error: 'Thiếu tên hoạt chất' });

  updateProgress(searchId, 'properties', 10, 'Khởi động tiến trình tra cứu ChEMBL...');

  try {
    updateProgress(searchId, 'properties', 20, 'Đang tìm kiếm hoạt chất trên ChEMBL...');
    const searchData = await get('https://www.ebi.ac.uk/chembl/api/data/molecule/search.json', {
      q: drugName, limit: 1,
    });
    const molecules = searchData.molecules || [];
    if (!molecules.length) {
      updateProgress(searchId, 'properties', 100, 'Không tìm thấy hoạt chất trên ChEMBL.');
      return res.status(404).json({ error: `Không tìm thấy "${drugName}" trong ChEMBL` });
    }

    const mol      = molecules[0];
    const chemblId = mol.molecule_chembl_id;
    const props    = mol.molecule_properties || {};
    const structs  = mol.molecule_structures || {};

    updateProgress(searchId, 'properties', 50, `Đang tải chi tiết cấu trúc cho ${chemblId}...`);
    const [detailRes, mechRes] = await Promise.allSettled([
      get(`https://www.ebi.ac.uk/chembl/api/data/molecule/${chemblId}.json`),
      get('https://www.ebi.ac.uk/chembl/api/data/mechanism.json', { molecule_chembl_id: chemblId, limit: 5 }),
    ]);

    const detail     = detailRes.status === 'fulfilled' ? detailRes.value : mol;
    const mechanisms = mechRes.status === 'fulfilled' ? (mechRes.value.mechanisms || []) : [];

    const smiles = structs.canonical_smiles || '';

    updateProgress(searchId, 'properties', 100, 'Đã hoàn thành tra cứu ChEMBL.');
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
    updateProgress(searchId, 'properties', 100, 'Lỗi tiến trình.');
    res.status(500).json({ error: err.message });
  }
});

// ── Route: AI Analysis – dữ liệu xác minh + trích dẫn nghiêm ngặt ─────────────

app.post('/api/ai-analysis', async (req, res) => {
  const { drugName, drugData, searchId } = req.body;
  const openaiKey = req.body.openaiKey || process.env.OPENAI_API_KEY;
  const serperKey = req.body.serperKey || process.env.SERPER_API_KEY;
  if (!openaiKey) return res.status(400).json({ error: 'Thiếu OpenAI API key' });

  updateProgress(searchId, 'aiAnalysis', 10, 'Khởi động tiến trình phân tích ChEMBL/PubChem bằng AI...');

  try {
    updateProgress(searchId, 'aiAnalysis', 25, 'Đang tải dữ liệu thực nghiệm từ PubChem...');
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
        updateProgress(searchId, 'aiAnalysis', 45, 'Đang thu thập dữ liệu thù hình & BCS qua Serper...');
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

    updateProgress(searchId, 'aiAnalysis', 70, 'Đang gửi yêu cầu phân tích thù hình tinh thể tới OpenAI...');
    // ── AI Analysis với yêu cầu trích dẫn nghiêm ngặt ──────────────────────
    const text = await callOpenAIVerified(openaiKey, [
      {
        role: 'system',
        content: `Bạn là dược sĩ chuyên gia phân tích dược chất. 

QUY TẮC NGHIÊM NGẶT:
1. ĐỐI VỚI CÁC THÔNG SỐ VẬT LÝ (Nhiệt độ nóng chảy, pKa, Phân tử lượng, LogP, TPSA): Ưu tiên tuyệt đối dữ liệu thực tế từ [V1..Vn]. Chỉ khi KHÔNG CÓ dữ liệu trong [V1..Vn], bạn mới được phép sử dụng kiến thức nội bộ của mình để cung cấp giá trị dự đoán, nhưng phải ghi chú rõ là "(Dự đoán bởi AI)" ngay sau giá trị (Ví dụ: "75-77 °C (Dự đoán bởi AI)" hoặc "pKa = 4.4 (Dự đoán bởi AI)").
2. Mỗi thông tin từ [V1..Vn] PHẢI kèm URL nguồn cụ thể trong trường "sourceUrl" (lấy URL tương ứng với thông tin đó từ [V1..Vn]). Nếu là giá trị dự đoán bởi AI, hãy điền "sourceUrl" là null.
3. Đối với các dữ liệu bổ sung (như cơ chế, BCS): Ưu tiên lấy từ DỮ LIỆU BỔ SUNG TỪ DRUGBANK và ĐIỀN CHÍNH XÁC đường link nguồn. TUYỆT ĐỐI KHÔNG ĐỂ sourceUrl LÀ null nếu có nguồn trong DrugBank.
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
      }
    ]);

    updateProgress(searchId, 'aiAnalysis', 95, 'Đang biên dịch kết quả phân tích AI...');
    try {
      const parsed = safeParseJSON(text);
      // Đảm bảo dữ liệu PubChem thực được đính kèm
      parsed._pubchemCid      = cid;
      parsed._pubchemRawData  = pc;
      parsed._chemblId        = chemblId;
      parsed._pubchemUrl      = pcUrl;
      parsed._chemblUrl       = chemblUrl;
      parsed._verifiedFacts   = verifiedFacts;
      updateProgress(searchId, 'aiAnalysis', 100, 'Hoàn thành.');
      res.json(parsed);
    } catch {
      updateProgress(searchId, 'aiAnalysis', 100, 'Hoàn thành.');
      res.json({ raw: text, _pubchemCid: cid, _pubchemRawData: pc });
    }
  } catch (err) {
    updateProgress(searchId, 'aiAnalysis', 100, 'Lỗi tiến trình.');
    res.status(500).json({ error: err.message });
  }
});


// ── Route: Forced Degradation (Semantic Scholar + Serper + OpenAI) ────────────


app.post('/api/forced-degradation', async (req, res) => {
  const { drugName, searchId } = req.body;
  const openaiKey = req.body.openaiKey || process.env.OPENAI_API_KEY;
  const serperKey = req.body.serperKey || process.env.SERPER_API_KEY;
  if (!openaiKey) return res.status(400).json({ error: 'Thiếu OpenAI API key' });

  updateProgress(searchId, 'stability', 5, 'Khởi động tiến trình tra cứu độ ổn định...');

  try {
    let papers     = [];   // {title, url, abstract, year, authors, body, source}
    let searchMode = 'ai-knowledge';

    if (serperKey) {
      try {
        updateProgress(searchId, 'stability', 10, 'Đang gửi 6 truy vấn tìm kiếm Google...');
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

        // Tải nội dung của tất cả liên kết thu được
        const chunkSize = 15; // Tăng concurrency lên 15 để tải nhanh hơn khi cào nhiều trang

        for (let i = 0; i < combined.length; i += chunkSize) {
          const chunk = combined.slice(i, i + chunkSize);
          updateProgress(searchId, 'stability', 20 + Math.round((i / combined.length) * 50), `Đang tải nội dung tài liệu: ${i}/${combined.length}...`);
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

    const aiPapers = sortedPapers.slice(0, 30);

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

    updateProgress(searchId, 'stability', 75, 'Đang gửi yêu cầu phân tích tổng hợp tới OpenAI...');
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

    updateProgress(searchId, 'stability', 95, 'Đang xử lý kết quả trả về từ AI...');
    try {
      const parsed       = safeParseJSON(text);
      let phParsed       = null;
      try { phParsed = safeParseJSON(phText); } catch(e) {}
      
      if (phParsed && phParsed.range) {
        parsed.stablePhRange = phParsed;
      }
      
      parsed.rawPapers   = papers.map((p) => ({ title: p.title, url: p.url, doi: p.doi, year: p.year, authors: p.authors, source: p.source, hasBody: p.body && p.body.length > 500 }));
      parsed.searchMode  = searchMode;
      updateProgress(searchId, 'stability', 100, 'Hoàn thành.');
      res.json(parsed);
    } catch {
      updateProgress(searchId, 'stability', 100, 'Hoàn thành.');
      res.json({ raw: text, rawPapers: papers.map((p) => ({ title: p.title, url: p.url, doi: p.doi, year: p.year, authors: p.authors, source: p.source, hasBody: p.body && p.body.length > 500 })), searchMode });
    }
  } catch (err) {
    updateProgress(searchId, 'stability', 100, 'Lỗi tiến trình.');
    res.status(500).json({ error: err.message });
  }
});

function normalizeDosageForm(form) {
  if (!form) return { vi: '', en: '', ru: '' };
  const f = form.toLowerCase().trim();
  if (f.includes('nén') || f.includes('tablet') || f.includes('таблетки')) {
    return { vi: 'Viên nén', en: 'Tablet', ru: 'таблетки' };
  }
  if (f.includes('nang') || f.includes('capsule') || f.includes('капсулы')) {
    return { vi: 'Viên nang', en: 'Capsule', ru: 'капсулы' };
  }
  if (f.includes('hỗn dịch') || f.includes('suspension') || f.includes('суспензия')) {
    return { vi: 'Hỗn dịch', en: 'Suspension', ru: 'суспензия' };
  }
  if (f.includes('dung dịch') || f.includes('solution') || f.includes('раствор')) {
    return { vi: 'Dung dịch', en: 'Solution', ru: 'раствор' };
  }
  if (f.includes('tiêm') || f.includes('injection') || f.includes('инъекция')) {
    return { vi: 'Thuốc tiêm', en: 'Injection', ru: 'раствор для инъекций' };
  }
  if (f.includes('mỡ') || f.includes('kem') || f.includes('gel') || f.includes('cream') || f.includes('ointment') || f.includes('мазь')) {
    return { vi: 'Thuốc mỡ/Kem/Gel', en: 'Ointment/Cream/Gel', ru: 'мазь/крем/гель' };
  }
  return { vi: form, en: form, ru: form };
}

// ── Route: Vidal.ru Formulas (Thay thế SRA) ───────────────────────────────────────────────

app.post('/api/sra-formulas', async (req, res) => {
  const { drugName, dosageForm, searchId } = req.body;
  const openaiKey = req.body.openaiKey || process.env.OPENAI_API_KEY;
  if (!drugName || !dosageForm) return res.status(400).json({ error: 'Thiếu tên hoạt chất hoặc dạng bào chế' });
  if (!openaiKey) return res.status(400).json({ error: 'Thiếu OpenAI API key' });

  updateProgress(searchId, 'vidal', 5, 'Khởi động tiến trình tra cứu công thức Nga...');

  try {
    const normalized = normalizeDosageForm(dosageForm);
    const cheerio = require('cheerio');
    // 1. Tìm kiếm trên Vidal.ru
    updateProgress(searchId, 'vidal', 10, 'Đang truy vấn công thức trên Vidal.ru...');
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
      updateProgress(searchId, 'vidal', 100, 'Không tìm thấy sản phẩm nào.');
      return res.json({ products: [], totalProducts: 0, dataSource: 'Vidal.ru (Nga)' });
    }

    // 2. Lấy dữ liệu chi tiết (tất cả sản phẩm) với concurrency limit
    const productData = [];
    const chunkSize = 15; // Tăng lên 15 request cùng lúc để cào tất cả sản phẩm nhanh hơn
    const chunks = [];
    for (let i = 0; i < links.length; i += chunkSize) {
      chunks.push(links.slice(i, i + chunkSize));
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const processedCount = i * chunkSize;
      updateProgress(searchId, 'vidal', 20 + Math.round((processedCount / links.length) * 60), `Đang tải chi tiết sản phẩm: ${processedCount}/${links.length}...`);
      
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
    updateProgress(searchId, 'vidal', 80, 'Đang gửi dữ liệu tiếng Nga tới OpenAI để dịch...');
    const promptData = productData.map((p, i) => `[Sản phẩm ${i + 1}]\nTên: ${p.title}\nURL: ${p.url}\nThành phần (Tiếng Nga): ${p.text}`).join('\n\n');
    
    const aiSystem = `Bạn là chuyên gia bào chế và phiên dịch Dược phẩm Nga. Nhiệm vụ:
1. Đọc các bản ghi thành phần từ Vidal.ru.
2. LỌC: CHỈ giữ lại các sản phẩm khớp với dạng bào chế mục tiêu.
   Dạng bào chế mục tiêu được định nghĩa là: Tiếng Việt: "${normalized.vi}", Tiếng Anh: "${normalized.en}", Tiếng Nga: "${normalized.ru}". Bỏ qua các sản phẩm không khớp.
3. DỊCH TOÀN BỘ TÊN THÀNH PHẦN SANG TIẾNG VIỆT VÀ PHÂN TÍCH VAI TRÒ TÁ DƯỢC: 
   - Dịch tên Hoạt chất (activeIngredient) sang tiếng Việt.
   - Dịch TẤT CẢ các thành phần tá dược (вспомогательные вещества) sang tiếng Việt.
   - Đối với mỗi tá dược, hãy dùng kiến thức AI chuyên sâu của bạn về hóa dược để phân tích vai trò cụ thể của nó trong công thức này (ví dụ: Tá dược rã, Tá dược dính, Tá dược trơn, Tá dược độn, Chất điều hương, Chất bảo quản, Tá dược bao, v.v.).
   - PHẢI GIỮ NGUYÊN HÀM LƯỢNG VÀ SỐ LƯỢNG (nếu có trong dữ liệu gốc tiếng Nga, ví dụ: "25,5 mg"). Nếu không có hàm lượng cụ thể, để là "N/A" hoặc "vừa đủ".
   - TÁCH BIỆT RÕ RÀNG: Tuyệt đối không để lẫn hàm lượng/số lượng bên trong trường "name" (tên tá dược). Tên tá dược phải sạch (ví dụ: "lactose monohydrat"), còn hàm lượng phải được đưa riêng vào trường "amount" (ví dụ: "100 mg" hoặc "vừa đủ").
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
      "excipients": [
        {
          "name": "Tên tá dược sạch (không kèm hàm lượng, ví dụ: cellulose vi tinh thể)",
          "amount": "Hàm lượng/Số lượng (ví dụ: 25.5 mg hoặc vừa đủ hoặc N/A)",
          "role": "Vai trò của tá dược (ví dụ: Tá dược độn, tá dược dính khô)"
        }
      ],
      "manufacturingProcess": "Đề xuất quy trình bào chế chi tiết từng bước (step-by-step: Bước 1: ..., Bước 2: ..., Bước 3: ...), phù hợp với dạng bào chế và các tá dược có trong công thức. Nêu rõ lý do lựa chọn phương pháp bào chế (ví dụ: dập thẳng, xát hạt ướt, nhũ hóa...) dựa trên tính chất các tá dược có sẵn.",
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

    updateProgress(searchId, 'vidal', 95, 'Đang biên dịch kết quả tiếng Nga...');
    let parsed = { products: [] };
    try {
      parsed = safeParseJSON(text);
    } catch {
      console.error('Lỗi parse JSON từ AI');
    }

    updateProgress(searchId, 'vidal', 100, 'Hoàn thành.');
    res.json({
      products: parsed.products || [],
      totalProducts: (parsed.products || []).length,
      dataSource: 'Vidal.ru (Nga)',
      commonExcipients: parsed.commonExcipients || [],
      formulationInsights: parsed.formulationInsights || ''
    });
  } catch (err) {
    console.error('Vidal Error:', err);
    updateProgress(searchId, 'vidal', 100, 'Lỗi tiến trình.');
    res.status(500).json({ error: err.message });
  }
});

// ── Route: Patents ────────────────────────────────────────────────────────────

app.post('/api/patents', async (req, res) => {
  const { drugName, dosageForm, searchId } = req.body;
  const openaiKey = req.body.openaiKey || process.env.OPENAI_API_KEY;
  const serperKey = req.body.serperKey || process.env.SERPER_API_KEY;
  if (!openaiKey || !serperKey) return res.status(400).json({ error: 'Thiếu API key' });

  updateProgress(searchId, 'patents', 5, 'Khởi động tiến trình tra cứu patent...');

  try {
    const normalized = normalizeDosageForm(dosageForm);
    updateProgress(searchId, 'patents', 15, 'Đang tìm kiếm trên Google Patents...');
    const q = `"${drugName}"${normalized.en ? ` "${normalized.en}"` : ''} patent`;
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
    const targetPatents = unique.slice(0, 15);
    for (let i = 0; i < targetPatents.length; i++) {
      const p = targetPatents[i];
      updateProgress(searchId, 'patents', 30 + Math.round((i / targetPatents.length) * 50), `Đang tải nội dung bằng sáng chế: ${i}/${targetPatents.length}...`);
      await delay(200);
      const body = await fetchText(p.link);
      docs.push({ title: p.title, url: p.link, snippet: p.snippet, body: body || '' });
    }

    updateProgress(searchId, 'patents', 80, 'Đang gửi dữ liệu bằng sáng chế tới OpenAI để phân tích...');
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

    updateProgress(searchId, 'patents', 95, 'Đang xử lý phân tích patent...');
    try {
      const parsed    = safeParseJSON(text);
      parsed.rawLinks = unique.map((r) => ({ title: r.title, url: r.link, snippet: r.snippet }));
      updateProgress(searchId, 'patents', 100, 'Hoàn thành.');
      res.json(parsed);
    } catch {
      updateProgress(searchId, 'patents', 100, 'Hoàn thành.');
      res.json({ raw: text, rawLinks: unique });
    }
  } catch (err) {
    updateProgress(searchId, 'patents', 100, 'Lỗi tiến trình.');
    res.status(500).json({ error: err.message });
  }
});

// ── Route: Pharmacopoeia Search ───────────────────────────────────────────────
// Cache dữ liệu webofpharma để không phải fetch lại mỗi lần
let _pharmacoData = null;
let _pharmacoFetchedAt = 0;

async function getPharmacoeiaData() {
  const now = Date.now();
  if (_pharmacoData && now - _pharmacoFetchedAt < 6 * 60 * 60 * 1000) return _pharmacoData; // cache 6h
  console.log('[Pharmacopoeia] Fetching data from webofpharma.com...');
  const res = await axios.get('https://www.webofpharma.com/2025/08/pharmacopoeia-search-engine.html', {
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' }
  });
  const html = res.data;
  // Trích xuất mảng pharmacopoeiaData từ JavaScript trong HTML
  const match = html.match(/const pharmacopoeiaData\s*=\s*(\[[\s\S]*?\]);\s*(?:\/\/|function|const|let|var|document|\n\s*\n)/);
  if (!match) throw new Error('Không thể trích xuất dữ liệu pharmacopoeia từ webofpharma.com');
  const vm = require('vm');
  _pharmacoData = vm.runInNewContext(match[1]);
  _pharmacoFetchedAt = now;
  console.log(`[Pharmacopoeia] Loaded ${_pharmacoData.length} entries.`);
  return _pharmacoData;
}

// ── Route: Proxy image from PharmDE to avoid CORS/Hotlinking ──────────────────
app.get('/api/compatibility/image', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('https://pharmde.computpharm.org/static/')) {
    return res.status(400).send('Invalid image URL');
  }
  try {
    const imgRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    res.set('Content-Type', 'image/svg+xml');
    res.send(imgRes.data);
  } catch (e) {
    res.status(404).send('Image not found');
  }
});

// ── Route: Drug-Excipient Compatibility (PharmDE) ─────────────────────────────
app.post('/api/compatibility', async (req, res) => {
  const { drugName, smiles, searchId } = req.body;
  if (!drugName) return res.status(400).json({ error: 'Thiếu tên hoạt chất' });

  updateProgress(searchId, 'compatibility', 10, 'Bắt đầu kiểm tra tương tác hoạt chất - tá dược...');

  let targetSmiles = smiles;

  // 1. Nếu chưa có SMILES, tìm kiếm trên PubChem
  if (!targetSmiles) {
    try {
      updateProgress(searchId, 'compatibility', 30, 'Đang tìm kiếm cấu trúc SMILES của hoạt chất trên PubChem...');
      const pcRes = await axios.get(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(drugName)}/property/CanonicalSMILES/JSON`, { timeout: 10000 });
      const prop = pcRes.data?.PropertyTable?.Properties?.[0];
      if (prop) {
        targetSmiles = prop.CanonicalSMILES || prop.ConnectivitySMILES || prop.IsomericSMILES;
      }
    } catch (e) {
      console.error('[Compatibility] PubChem SMILES error:', e.message);
    }
  }

  if (!targetSmiles) {
    updateProgress(searchId, 'compatibility', 100, 'Không tìm thấy SMILES của hoạt chất.');
    return res.status(404).json({ error: 'Không tìm thấy cấu trúc SMILES của hoạt chất để phân tích.' });
  }

  // 2. Truy vấn pharmde.computpharm.org
  try {
    updateProgress(searchId, 'compatibility', 60, 'Đang gửi yêu cầu phân tích tới hệ thống chuyên gia PharmDE...');
    const url = `https://pharmde.computpharm.org/home/predict-drug-results?keywords=${encodeURIComponent(targetSmiles)}`;
    const pharmRes = await axios.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    const cheerio = require('cheerio');
    const $ = cheerio.load(pharmRes.data);
    const incompatibilities = [];

    $('.row.x_content').each((i, el) => {
      const imgPath = $(el).find('.image img').attr('src') || '';
      const rawImgUrl = imgPath ? 'https://pharmde.computpharm.org' + imgPath : '';
      const imageUrl = rawImgUrl ? `/api/compatibility/image?url=${encodeURIComponent(rawImgUrl)}` : '';

      const $table = $(el).find('table.info_table');
      if ($table.length === 0) return;

      const title = $table.find('h5 u').text().trim() || 'Tương tác';

      const item = {
        title,
        imageUrl,
        reactionType: '',
        description: '',
        riskGroups: '',
        riskGroupsFormula: '',
        riskExcipientType: '',
        riskExcipientNames: []
      };

      $table.find('tr').each((j, tr) => {
        const th = $(tr).find('th').text().trim().toLowerCase();
        const td = $(tr).find('td');

        if (th.includes('reaction type')) {
          item.reactionType = td.text().trim();
        } else if (th.includes('description')) {
          item.description = td.text().trim();
        } else if (th.includes('risk groups in excipients')) {
          item.riskGroups = td.text().trim();
        } else if (th.includes('risk groups foamula') || th.includes('formula')) {
          item.riskGroupsFormula = td.text().trim();
        } else if (th.includes('excipient type')) {
          item.riskExcipientType = td.text().trim();
        } else if (th.includes('excipient name')) {
          const names = [];
          td.find('.badge').each((k, badge) => {
            names.push($(badge).text().trim());
          });
          item.riskExcipientNames = names;
        }
      });

      incompatibilities.push(item);
    });

    // 3. Dịch kết quả sang tiếng Việt bằng OpenAI sử dụng Dictionary dịch thuật tối ưu
    let finalIncompatibilities = incompatibilities;
    const openaiKey = req.body.openaiKey || process.env.OPENAI_API_KEY;
    if (incompatibilities.length > 0 && openaiKey) {
      try {
        updateProgress(searchId, 'compatibility', 85, 'Đang dịch kết quả tương tác sang tiếng Việt bằng AI...');
        
        // Thu thập các chuỗi duy nhất cần dịch để tối ưu hóa token và tránh lỗi cắt cụt JSON
        const phrasesToTranslate = new Set();
        incompatibilities.forEach(item => {
          if (item.title) phrasesToTranslate.add(item.title);
          if (item.reactionType) phrasesToTranslate.add(item.reactionType);
          if (item.description) phrasesToTranslate.add(item.description);
          if (item.riskGroups) phrasesToTranslate.add(item.riskGroups);
          if (item.riskExcipientType) phrasesToTranslate.add(item.riskExcipientType);
          if (item.riskExcipientNames) {
            item.riskExcipientNames.forEach(name => phrasesToTranslate.add(name));
          }
        });

        const phrasesList = Array.from(phrasesToTranslate);
        
        // Tạo đối tượng ánh xạ với khóa ngắn hạn (p0, p1, p2...) để giảm dung lượng JSON và tránh lỗi parse
        const inputObj = {};
        phrasesList.forEach((phrase, idx) => {
          inputObj[`p${idx}`] = phrase;
        });
        
        const translationPrompt = `Bạn là một dược sĩ chuyên ngành hóa dược và dịch thuật chuyên nghiệp.
Hãy dịch các từ/cụm từ/đoạn văn dưới đây sang tiếng Việt chuyên ngành dược phẩm. 
Yêu cầu:
1. Dịch chuẩn xác thuật ngữ chuyên ngành (ví dụ: "Ester bond" -> "Liên kết ester", "Hydrolysis of ester" -> "Thủy phân ester", "Esterification" -> "Phản ứng ester hóa", "hygroscopicity" -> "tính hút ẩm").
2. Giữ nguyên cấu trúc JSON trả về dưới dạng một đối tượng chứa các khóa giống hệt như đầu vào (ví dụ: "p0", "p1", "p2"...). Không thay đổi tên các khóa này, chỉ dịch các giá trị văn bản sang tiếng Việt.
3. Trả về đúng định dạng JSON dạng: {"p0": "Bản dịch của p0", "p1": "Bản dịch của p1", ...} và KHÔNG dùng markdown.

Danh sách cụm từ cần dịch:
${JSON.stringify(inputObj, null, 2)}`;

        const translatedText = await callOpenAI(openaiKey, [
          { role: 'system', content: 'Bạn là trợ lý dịch thuật từ điển chuyên ngành dược phẩm. Trả về JSON dictionary hợp lệ không dùng markdown.' },
          { role: 'user', content: translationPrompt }
        ], 'gpt-4o-mini', 2);
        
        const dictionary = safeParseJSON(translatedText);
        
        if (dictionary && typeof dictionary === 'object') {
          // Xây dựng map ngược từ tiếng Anh gốc sang tiếng Việt đã dịch
          const translationMap = new Map();
          phrasesList.forEach((phrase, idx) => {
            const translated = dictionary[`p${idx}`];
            if (translated) {
              translationMap.set(phrase, translated);
            }
          });

          finalIncompatibilities = incompatibilities.map(item => {
            const translate = (val) => {
              if (!val) return val;
              return translationMap.get(val) || val;
            };
            
            return {
              title: translate(item.title),
              imageUrl: item.imageUrl,
              reactionType: translate(item.reactionType),
              description: translate(item.description),
              riskGroups: translate(item.riskGroups),
              riskGroupsFormula: item.riskGroupsFormula,
              riskExcipientType: translate(item.riskExcipientType),
              riskExcipientNames: item.riskExcipientNames ? item.riskExcipientNames.map(name => translate(name)) : []
            };
          });
        }
      } catch (e) {
        console.error('[Compatibility translation dictionary error]', e.message);
      }
    }

    updateProgress(searchId, 'compatibility', 100, `Hoàn thành phân tích: tìm thấy ${incompatibilities.length} tương tác.`);
    res.json({
      smiles: targetSmiles,
      incompatibilities: finalIncompatibilities,
      total: incompatibilities.length,
      sourceUrl: url
    });
  } catch (err) {
    console.error('[Compatibility error]', err.message);
    updateProgress(searchId, 'compatibility', 100, 'Lỗi kết nối tới PharmDE.');
    res.status(500).json({ error: 'Không thể kết nối tới máy chủ PharmDE: ' + err.message });
  }
});

app.post('/api/pharmacopoeia/search', async (req, res) => {
  const { drugName, searchId } = req.body;
  if (!drugName) return res.status(400).json({ error: 'Thiếu tên hoạt chất' });

  updateProgress(searchId, 'pharma', 20, 'Đang tải dữ liệu dược điển...');
  try {
    const allData = await getPharmacoeiaData();
    updateProgress(searchId, 'pharma', 60, 'Đang phân tích các monograph...');
    const q = drugName.trim().toLowerCase();
    // Tạo các từ khoá tìm kiếm: tên gốc + tên thay thế phổ biến
    const aliases = [q];
    if (q === 'paracetamol' || q === 'acetaminophen') { aliases.push('paracetamol', 'acetaminophen'); }

    const results = allData.filter(entry => {
      const t = (entry.title || '').toLowerCase();
      return aliases.some(a => t.includes(a));
    });

    // Nhóm theo dạng bào chế (trích từ title)
    const grouped = {};
    for (const entry of results) {
      const title = entry.title || '';
      // Phát hiện dạng bào chế từ title
      let form = 'General/Bulk';
      const tl = title.toLowerCase();
      if (tl.includes('extended-release tablet') || tl.includes('prolonged-release tablet') || tl.includes('modified-release tablet')) form = 'Extended-Release Tablet';
      else if (tl.includes('effervescent tablet') || tl.includes('effervescent oral')) form = 'Effervescent Tablet';
      else if (tl.includes('chewable tablet')) form = 'Chewable Tablet';
      else if (tl.includes('dispersible tablet')) form = 'Dispersible Tablet';
      else if (tl.includes('tablet')) form = 'Tablet';
      else if (tl.includes('extended-release capsule') || tl.includes('prolonged-release capsule')) form = 'Extended-Release Capsule';
      else if (tl.includes('capsule')) form = 'Capsule';
      else if (tl.includes('oral solution') || tl.includes('oral liquid')) form = 'Oral Solution';
      else if (tl.includes('oral suspension') || tl.includes('suspension')) form = 'Suspension';
      else if (tl.includes('oral drops') || tl.includes('drops')) form = 'Oral Drops';
      else if (tl.includes('syrup')) form = 'Syrup';
      else if (tl.includes('granule') || tl.includes('granules')) form = 'Granules';
      else if (tl.includes('powder')) form = 'Powder';
      else if (tl.includes('injection') || tl.includes('infusion') || tl.includes('parenteral')) form = 'Injection/Infusion';
      else if (tl.includes('suppositorie') || tl.includes('suppository')) form = 'Suppository';
      else if (tl.includes('cream') || tl.includes('ointment') || tl.includes('gel')) form = 'Topical';
      else if (tl.includes('eye drop') || tl.includes('ophthalmic')) form = 'Ophthalmic';
      else if (tl.includes('patch') || tl.includes('transdermal')) form = 'Transdermal';
      if (!grouped[form]) grouped[form] = [];
      grouped[form].push({ id: entry.id, title, book: entry.book, description: entry.description, pdfUrl: entry.pdfUrl });
    }

    updateProgress(searchId, 'pharma', 100, 'Hoàn thành.');
    res.json({ total: results.length, grouped });
  } catch (err) {
    updateProgress(searchId, 'pharma', 100, 'Lỗi tiến trình.');
    console.error('[Pharmacopoeia search error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pharmacopoeia/standards', async (req, res) => {
  const { drugName, dosageForm, selectedMonograph, openaiKey } = req.body;
  if (!drugName || !dosageForm || !selectedMonograph) {
    return res.status(400).json({ error: 'Thiếu tên hoạt chất, dạng bào chế hoặc monograph được chọn' });
  }
  const apiKey = openaiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Thiếu OpenAI API key' });

  try {
    let monographText = '';
    if (selectedMonograph.pdfUrl) {
      console.log(`[Pharmacopoeia] Fetching and parsing PDF monograph: ${selectedMonograph.pdfUrl}`);
      monographText = await fetchPdf(selectedMonograph.pdfUrl);
    }

    const prompt = `Bạn là chuyên gia kiểm tra chất lượng (QC Specialist) dược phẩm.
Nhiệm vụ: Xây dựng tiêu chuẩn chất lượng cho hoạt chất "${drugName}", dạng bào chế "${dosageForm}" dựa trên Monograph được lựa chọn dưới đây:
- Dược điển: ${selectedMonograph.book}
- Tên Monograph: ${selectedMonograph.title}
- Link Monograph: ${selectedMonograph.pdfUrl}

NỘI DUNG CHI TIẾT CỦA MONOGRAPH (Đã trích xuất từ PDF gốc):
${monographText || '(Không trích xuất được văn bản từ PDF, hãy tự suy luận dựa trên kiến thức dược điển chính xác của bạn)'}

YÊU CẦU NGHIÊM NGẶT (CRITICAL RULES):
1. Bạn phải xây dựng các tiêu chí này dựa 100% trên Dược điển đã chọn (${selectedMonograph.book}) và tài liệu đính kèm bên trên.
2. TUYỆT ĐỐI KHÔNG TỰ BIÊN TỰ DIỄN, không bịa đặt hoặc tự ý thêm các chỉ tiêu, thông số, giới hạn hay thuốc thử không có trong quy định của dược điển này. Tất cả thông tin phải chính xác theo quy chuẩn của Dược điển được chọn.
3. Phần Dược điển tham chiếu trong bảng tiêu chuẩn phải ghi rõ và chính xác là Dược điển được chọn (ví dụ: "${selectedMonograph.book}").

Hãy xây dựng đầy đủ và chi tiết theo 3 phần, trả về JSON hợp lệ (KHÔNG có markdown):

{
  "qualityStandards": [
    {
      "stt": 1,
      "chiTieu": "Cảm quan",
      "yeuCau": "Mô tả yêu cầu chi tiết theo dược điển",
      "duocDien": "USP 2025 / BP 2024 / EP 11 / DĐVN V"
    }
  ],
  "hplcConditions": [
    {
      "thongSo": "Tên cột",
      "giaTriYeuCau": "C18, 250 x 4.6 mm, 5 µm",
      "ghiChu": "Ví dụ: Waters Symmetry, Agilent Zorbax..."
    }
  ],
  "chemicals": [
    {
      "ten": "Tên hóa chất / chất đối chiếu",
      "loai": "Chất đối chiếu / Dung môi / Thuốc thử / Đệm",
      "mucDich": "Mục đích sử dụng trong phép thử nào"
    }
  ]
}

Tiêu chuẩn chất lượng (qualityStandards) phải tuân thủ nghiêm ngặt các quy tắc sau:
1. CHỈ đưa vào các chỉ tiêu thực sự được quy định cụ thể trong chuyên luận Monograph của Dược điển được chọn.
2. TUYỆT ĐỐI KHÔNG tự bịa ra các chỉ tiêu hoặc thông số không có trong chuyên luận Monograph đó. Ví dụ: Các chuyên luận viên nén của USP/BP/EP thường KHÔNG quy định chỉ tiêu Độ cứng (Hardness) và Độ mài mòn (Friability) trong chuyên luận riêng. Do đó, nếu chuyên luận Monograph được chọn không ghi các chỉ tiêu này, bạn TUYỆT ĐỐI KHÔNG được đưa chúng vào bảng tiêu chuẩn.
3. Các chỉ tiêu bắt buộc của chuyên luận (như Định tính, Độ hòa tan, Tạp chất liên quan, Định lượng) phải được mô tả chính xác về yêu cầu và phương pháp thử theo Monograph.

Điều kiện HPLC (hplcConditions) phải trích xuất chính xác từ phương pháp HPLC quy định trong Monograph được chọn (cho phép thử Định lượng hoặc Tạp chất liên quan).

Danh sách hóa chất (chemicals) phải LIỆT KÊ ĐẦY ĐỦ 100% TOÀN BỘ các hóa chất, dung môi, chất đối chiếu được sử dụng trong tất cả các phương pháp thử nghiệm của chuyên luận đó (ví dụ: các chất đối chiếu chuẩn hoạt chất/tạp chất, dung môi pha động, dung môi pha loãng/pha mẫu, môi trường hòa tan, hóa chất điều chỉnh pH, đệm, thuốc thử định tính...). 
ĐẶC BIỆT LƯU Ý: 
- Đối với dược điển USP và BP, hầu hết các hóa chất đều có dạng liên kết markdown như "[Tên hóa chất](đường link)" (ví dụ: "[methanol](...)", "[USP Acetaminophen RS](...)"). Bạn hãy quét kỹ toàn bộ văn bản để tìm tất cả các liên kết này và đưa tên hóa chất vào danh sách.
- Đối với Dược điển Nhật (JP), châu Âu (EP) hoặc các Dược điển khác, các hóa chất thường KHÔNG có liên kết gạch chân. Do đó, bạn phải đọc cực kỳ cẩn thận toàn bộ văn bản Monograph từ đầu đến cuối (bao gồm cả các phần phụ như Purity, related substances, system suitability, selection of column, detector sensitivity, v.v.) để chủ động phát hiện và trích xuất mọi danh từ chỉ hóa chất, dung môi, chất đối chiếu, chất chuẩn hoặc đệm được nhắc đến.
- BẮT BUỘC PHẢI TRÍCH XUẤT các chất chuẩn đối chiếu phụ hoặc chất dùng cho việc chọn cột/kiểm tra độ phù hợp hệ thống (ví dụ: "4-aminophenol hydrochloride", "hexyl parahydroxybenzoate", "indometacin"...) được nêu trong quy trình.
- Tổng hợp từ cả hai nguồn trên để lập ra danh sách "chemicals" đầy đủ nhất. Tuyệt đối không được bỏ sót bất kỳ hóa chất nào được nhắc đến trong quy trình kiểm nghiệm của Monograph.`;

    const text = await callOpenAI(apiKey, [{ role: 'user', content: prompt }], 'gpt-4o-mini', 3);
    const parsed = safeParseJSON(text);
    res.json(parsed);
  } catch (err) {
    console.error('[Pharmacopoeia standards error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`\n🔬 Drug Research Pro đang chạy tại http://localhost:${PORT}`);
});
server.setTimeout(300000); // 5 minutes
