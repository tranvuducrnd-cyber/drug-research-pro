require('dotenv').config({ path: require('path').resolve(__dirname, '.env'), override: true });
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const { PDFParse } = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Supabase (service-role client, chỉ dùng trên server) ────────────────────
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

async function requireApprovedUser(req, res, next) {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase chưa được cấu hình trên server.' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Thiếu Bearer token. Vui lòng đăng nhập.' });

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles').select('status, role').eq('id', user.id).single();
  if (profileErr || !profile) return res.status(403).json({ error: 'Không tìm thấy hồ sơ người dùng.' });
  if (profile.status !== 'approved') return res.status(403).json({ error: 'Tài khoản chưa được duyệt.' });

  req.user = user;
  req.profile = profile;
  next();
}

function requireAdmin(req, res, next) {
  if (req.profile?.role !== 'admin') return res.status(403).json({ error: 'Yêu cầu quyền admin.' });
  next();
}

app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
});

app.post('/api/admin/invite-user', requireApprovedUser, requireAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Thiếu email' });

  try {
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: process.env.PUBLIC_APP_URL || undefined,
    });
    if (error) return res.status(400).json({ error: error.message });

    const { error: approveErr } = await supabaseAdmin
      .from('profiles').update({ status: 'approved' }).eq('id', data.user.id);
    if (approveErr) return res.status(500).json({ error: approveErr.message });

    res.json({ success: true, email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
      await callOpenAI(openaiKey, [{ role: 'user', content: 'hello' }], 'openai/gpt-5-nano', 1);
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
    // verbosity: 0 (ERRORS only) — tránh flood hàng trăm console.warn "standardFontDataUrl"
    // khi PDF dùng font hệ thống không nhúng, có thể làm treo event loop/server khi PDF lớn.
    const parser = new PDFParse({ data: uint8, verbosity: 0 });
    const data = await parser.getText();
    // Bảng kết quả (VD "Table: Force Degradation Results") thường nằm SAU phần Methods,
    // nếu cắt sớm ở 20k sẽ mất luôn số liệu %phân hủy — tăng lên 40k để không bỏ sót phần Kết quả.
    return data.text.trim().slice(0, 40000);
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

    const isPatentOrVidal = url.includes('patents.google.com') || url.includes('vidal.ru');
    const res = await axios.get(url, {
      timeout: isPatentOrVidal ? 3000 : 10000,
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


// OpenRouter (https://openrouter.ai) - tương thích API với OpenAI, chỉ khác base URL,
// header HTTP-Referer/X-Title, và tên model phải có tiền tố nhà cung cấp (vd: "openai/gpt-5-nano").
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

async function callOpenAI(apiKey, messages, model = 'openai/gpt-5-nano', retries = 3, maxTokens = 16000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.post(
        OPENROUTER_URL,
        // reasoning effort "low" — model gpt-5 dùng rất nhiều "reasoning tokens" ẩn (tính vào
        // max_tokens); nếu để mặc định, phần lớn ngân sách token bị suy luận ẩn ăn hết, không còn
        // chỗ để viết JSON trả lời, gây rỗng/cắt cụt output.
        { model, messages, temperature: 0.3, max_tokens: maxTokens, reasoning: { effort: 'low' } },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.PUBLIC_APP_URL || 'http://localhost:3000',
            'X-Title': 'Hỗ trợ nghiên cứu',
          },
          timeout: 90000,
        }
      );
      return res.data.choices[0].message.content;
    } catch (e) {
      const is429 = e.response && e.response.status === 429;
      if (i === retries - 1) throw e;
      const waitMs = is429 ? (i + 1) * 8000 : 2000; // 429: chờ 8s, 16s, 24s
      console.error(`OpenRouter error (${e.message}). ${is429 ? '429 rate limit, ' : ''}Retrying in ${waitMs/1000}s... (${i+1}/${retries})`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

async function callOpenAIVerified(apiKey, messages, model = 'openai/gpt-5-nano') {
  // Chỉ gọi AI 1 lần (đã bỏ lượt kiểm định chéo lần 2 để giảm thời gian chờ).
  return await callOpenAI(apiKey, messages, model);
}

// Phân tích các dạng thù hình tinh thể (polymorphism) bằng DeepSeek (:online) —
// model này tự tìm kiếm web thật cho từ khóa "<hoạt chất> Polymorphism", đọc kỹ ít nhất
// 5 bài báo/patent liên quan rồi tóm tắt lại, thay vì chỉ dựa vào snippet Serper.
async function analyzePolymorphsDeepSeek(apiKey, drugName) {
  const text = await callOpenAI(apiKey, [
    {
      role: 'system',
      content: `Bạn là chuyên gia hóa dược, có khả năng tìm kiếm web thời gian thực.

QUY TẮC NGHIÊM NGẶT:
1. Tìm kiếm web thật với từ khóa "${drugName} Polymorphism". Đọc kỹ ít NHẤT 5 bài báo khoa học hoặc patent liên quan đến các dạng thù hình tinh thể (polymorphic forms) của "${drugName}" trước khi trả lời.
2. TUYỆT ĐỐI KHÔNG bịa đặt: chỉ mô tả các dạng thù hình đã thực sự được công bố trong các nguồn bạn đọc được. Nếu không tìm đủ 5 nguồn, dùng số nguồn thực tế tìm được và nêu rõ.
3. Trường "sources" PHẢI là danh sách URL thật của các bài báo/patent bạn đã đọc (ít nhất 3-5 URL nếu tìm được), mỗi mục có "url" và "title".
4. Nếu hoạt chất này không có dữ liệu polymorphism công bố, ghi "overview": "Không tìm thấy dữ liệu công bố về các dạng thù hình tinh thể." và "sources": [].
5. Với MỖI dạng thù hình (mỗi phần tử trong "forms"), trường "characteristics" PHẢI nêu cụ thể (nếu nguồn có công bố): nhiệt độ nóng chảy riêng của dạng đó, hệ tinh thể (monoclinic/orthorhombic...), độ ổn định (bền/kém bền/dễ chuyển dạng), độ tan so với các dạng khác. Viết theo phong cách liệt kê ngắn gọn từng dạng như ví dụ: "Dạng I: dạng ổn định nhất, điểm nóng chảy khoảng X-Y°C, thường dùng trong bào chế thương mại."
6. Trả lời bằng tiếng Việt. Đầu ra CUỐI CÙNG phải là JSON hợp lệ, KHÔNG markdown, KHÔNG text nào khác ngoài JSON.`,
    },
    {
      role: 'user',
      content: `Tìm kiếm "${drugName} Polymorphism", đọc kỹ ít nhất 5 nguồn liên quan rồi trả về JSON:
{
  "overview": "Tổng quan: có bao nhiêu dạng thù hình, đặc điểm chung, dựa trên các nguồn đã đọc",
  "forms": [{"name": "Form I", "characteristics": "Hệ tinh thể, nhiệt độ nóng chảy riêng của dạng này, độ ổn định, độ tan — càng cụ thể càng tốt", "differences": "Khác biệt so với các dạng khác"}],
  "commercialForm": "Dạng nào bền nhất/phổ biến nhất trong dược phẩm",
  "morphology": "Hình dạng tiểu phân (kim, phiến, hạt, khối...) của dạng thương mại hoặc dạng chính",
  "sources": [{"url": "URL thật đã đọc", "title": "Tên bài báo/patent"}]
}`,
    },
  ], 'deepseek/deepseek-chat:online');
  return safeParseJSON(text);
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

// Dịch nhanh 1 mảng chuỗi tiếng Anh sang tiếng Việt chuyên ngành dược (dùng model rẻ, không cần web search).
// Trả về mảng cùng thứ tự/độ dài; nếu lỗi thì trả nguyên văn tiếng Anh (không chặn luồng chính).
async function translateTexts(apiKey, texts) {
  if (!texts.length) return texts;
  try {
    const inputObj = {};
    texts.forEach((t, idx) => { inputObj[`p${idx}`] = t; });
    const prompt = `Bạn là dược sĩ chuyên ngành hóa dược kiêm dịch thuật chuyên nghiệp.
Dịch các cụm từ/câu tiếng Anh dưới đây sang tiếng Việt chuyên ngành dược phẩm, giữ nguyên số liệu/đơn vị đo.
Giữ nguyên cấu trúc JSON, chỉ dịch giá trị, không đổi tên khóa.
Trả về đúng dạng JSON {"p0": "...", "p1": "...", ...}, KHÔNG dùng markdown.

Danh sách cần dịch:
${JSON.stringify(inputObj, null, 2)}`;
    const text = await callOpenAI(apiKey, [
      { role: 'system', content: 'Bạn là trợ lý dịch thuật từ điển chuyên ngành dược phẩm. Trả về JSON dictionary hợp lệ không dùng markdown.' },
      { role: 'user', content: prompt },
    ], 'openai/gpt-5-nano', 2);
    const dict = safeParseJSON(text);
    return texts.map((t, idx) => (dict && dict[`p${idx}`]) || t);
  } catch (e) {
    console.error('translateTexts error:', e.message);
    return texts;
  }
}

function safeParseJSON(text) {
  let cleaned = text.trim();
  // Nếu AI bọc JSON trong markdown code fence, chỉ lấy đúng phần bên trong fence đầu tiên
  // (bỏ qua mọi giải thích thừa AI có thể viết thêm trước/sau fence).
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Fallback: lấy từ dấu { đầu tiên đến dấu } cuối cùng — phòng trường hợp AI vẫn chèn
    // text giải thích ngoài JSON mà không dùng markdown fence.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw e;
  }
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

// ── Route: Validate Drug Name ─────────────────────────────────────────────────

app.post('/api/validate-drug', requireApprovedUser, async (req, res) => {
  const { drugName } = req.body;
  if (!drugName) return res.status(400).json({ valid: false, error: 'Thiếu tên hoạt chất' });

  try {
    // Chạy song song cả 3 nguồn (thay vì tuần tự) để giảm thời gian chờ tối đa từ ~24s xuống ~6s
    const [exactRes, autoRes, chemblRes] = await Promise.allSettled([
      axios.get(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(drugName)}/cids/JSON`, { timeout: 6000 }),
      axios.get(`https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound/${encodeURIComponent(drugName)}/JSON`, { timeout: 6000, params: { limit: 8 } }),
      axios.get(`https://www.ebi.ac.uk/chembl/api/data/molecule/search.json?q=${encodeURIComponent(drugName)}&limit=5`, { timeout: 6000, headers: { Accept: 'application/json' } }),
    ]);

    if (exactRes.status === 'fulfilled' && exactRes.value.data?.IdentifierList?.CID?.length > 0) {
      return res.json({ valid: true, cid: exactRes.value.data.IdentifierList.CID[0] });
    }

    const suggestions = [];
    if (autoRes.status === 'fulfilled') {
      const items = autoRes.value.data?.dictionary_terms?.compound || [];
      suggestions.push(...items);
    } else {
      console.error('[Validate] Autocomplete error:', autoRes.reason?.message);
    }

    if (chemblRes.status === 'fulfilled') {
      const mols = chemblRes.value.data?.molecules || [];
      for (const m of mols) {
        const name = m.pref_name || m.molecule_chembl_id;
        if (name && !suggestions.includes(name)) suggestions.push(name);
      }
    } else {
      console.error('[Validate] ChEMBL fallback error:', chemblRes.reason?.message);
    }

    return res.json({ valid: false, suggestions: suggestions.slice(0, 8) });
  } catch (err) {
    // Nếu tất cả API đều lỗi, cho phép tiếp tục (không chặn user)
    console.error('[Validate] Error:', err.message);
    return res.json({ valid: true, warning: 'Không thể xác minh tên hoạt chất, tiếp tục tìm kiếm.' });
  }
});

// ── Route: ChEMBL Properties ──────────────────────────────────────────────────

app.post('/api/properties', requireApprovedUser, async (req, res) => {
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
      smiles,
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

app.post('/api/ai-analysis', requireApprovedUser, async (req, res) => {
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

    // Dịch các giá trị tiếng Anh của PubChem sang tiếng Việt cho mục "Tính chất vật lý"
    // (description, color, solubility, meltingPoint) trước khi trả về frontend.
    updateProgress(searchId, 'aiAnalysis', 30, 'Đang dịch dữ liệu PubChem sang tiếng Việt...');
    const translateKeys = ['description', 'color', 'solubility', 'meltingPoint'];
    const toTranslate = [];
    for (const key of translateKeys) {
      for (const item of (pc[key] || [])) toTranslate.push(item);
    }
    if (toTranslate.length) {
      const translated = await translateTexts(openaiKey, toTranslate.map(i => i.value));
      toTranslate.forEach((item, idx) => { item.value = translated[idx]; });
    }

    let dbSnippets = '';
    let polymorphSnippets = '';
    let bcsSnippets = '';
    let polymorphImage = '';
    let polymorphImages = [];
    let physSnippets = '';
    let hygroSnippets = '';
    if (serperKey) {
      try {
        updateProgress(searchId, 'aiAnalysis', 45, 'Đang thu thập dữ liệu tính chất vật lý & BCS qua Serper...');
        const [dbRes, polyRes, polyRes2, bcsRes, imgRes, physRes1, physRes3, physRes4, hygroRes] = await Promise.all([
          serperSearch(`site:go.drugbank.com/drugs "${drugName}" properties OR half-life OR mechanism OR absorption`, serperKey, 5),
          serperSearch(`${drugName} Polymorphism`, serperKey, 5),
          serperSearch(`${drugName} các dạng thù hình tinh thể`, serperKey, 5),
          serperSearch(`${drugName} BCS classification`, serperKey, 3),
          serperImageSearch(`${drugName} polymorphism crystal morphology`, serperKey, 3),
          serperSearch(`${drugName} melting point solubility aqueous pH`, serperKey, 6),
          serperSearch(`site:go.drugbank.com "${drugName}" "physical description" OR appearance OR color OR solid OR powder OR crystal`, serperKey, 5),
          serperSearch(`site:chemspider.com "${drugName}"`, serperKey, 5),
          serperSearch(`${drugName} moisture-absorbing capacity`, serperKey, 6),
        ]);
        if (dbRes.organic && dbRes.organic.length > 0) {
          dbSnippets = dbRes.organic.map(r => `Nguồn: ${r.link}\nTrích đoạn: ${r.snippet}`).join('\n\n');
        }
        const polyOrganic = [...(polyRes.organic || []), ...(polyRes2.organic || [])];
        if (polyOrganic.length > 0) {
          polymorphSnippets = polyOrganic.map(r => `Nguồn: ${r.link}\nTiêu đề: ${r.title}\nTrích đoạn: ${r.snippet}`).join('\n\n');
        }
        if (bcsRes.organic && bcsRes.organic.length > 0) {
          bcsSnippets = bcsRes.organic.map(r => `Nguồn: ${r.link}\nTrích đoạn: ${r.snippet}`).join('\n\n');
        }
        if (imgRes.images && imgRes.images.length > 0) {
          polymorphImage = imgRes.images[0].imageUrl;
          polymorphImages = imgRes.images.map(im => im.imageUrl).filter(Boolean);
        }
        const physOrganic = [...(physRes1.organic || []), ...(physRes3.organic || []), ...(physRes4.organic || [])];
        if (physOrganic.length > 0) {
          physSnippets = physOrganic.map(r => `Nguồn: ${r.link}\nTiêu đề: ${r.title}\nTrích đoạn: ${r.snippet}`).join('\n\n');
        }
        if (hygroRes.organic && hygroRes.organic.length > 0) {
          hygroSnippets = hygroRes.organic.map(r => `Nguồn: ${r.link}\nTiêu đề: ${r.title}\nTrích đoạn: ${r.snippet}`).join('\n\n');
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
    // Polymorphism được phân tích riêng bằng DeepSeek (:online, đọc kỹ >=5 nguồn thật),
    // chạy song song với phân tích chính để không tốn thêm thời gian chờ.
    const deepseekPolyPromise = analyzePolymorphsDeepSeek(openaiKey, drugName).catch(e => {
      console.error('DeepSeek polymorph analysis error:', e.message);
      return null;
    });

    const text = await callOpenAIVerified(openaiKey, [
      {
        role: 'system',
        content: `Bạn là dược sĩ chuyên gia phân tích dược chất. Bạn có khả năng tìm kiếm web thời gian thực.

QUY TẮC NGHIÊM NGẶT:
1. TUYỆT ĐỐI KHÔNG được tự suy đoán/dự đoán/ước tính bằng trí nhớ/kiến thức nội bộ dưới BẤT KỲ hình thức nào, kể cả khi bạn "khá chắc chắn". CHỈ được điền giá trị khi có trích dẫn nguồn thật — hoặc từ các đoạn trích được cung cấp bên dưới, hoặc từ kết quả TÌM KIẾM WEB THẬT mà bạn tự thực hiện.
2. Trước khi kết luận "không có dữ liệu", hãy đọc kỹ TOÀN BỘ các đoạn trích trong DỮ LIỆU TÍNH CHẤT VẬT LÝ, DỮ LIỆU BỔ SUNG TỪ DRUGBANK, DỮ LIỆU THÙ HÌNH TINH THỂ, DỮ LIỆU KHẢ NĂNG HÚT ẨM, và DỮ LIỆU BCS được cung cấp bên dưới.
3. NẾU các đoạn trích được cung cấp không có thông tin cho một trường cụ thể (ví dụ: nhiệt độ nóng chảy, độ tan, khả năng hút ẩm, pKa), BẮT BUỘC bạn phải tự dùng công cụ tìm kiếm web của mình để tìm kiếm thêm (ví dụ: tìm "melting point of ${drugName}", "hygroscopicity of ${drugName}", safety data sheet, patent, bài báo khoa học...) TRƯỚC KHI kết luận là không có.
4. Chỉ khi tìm kiếm web thật cũng không ra kết quả, PHẢI ghi "value": "Không tìm thấy dữ liệu công bố" và "sourceUrl": null. TUYỆT ĐỐI KHÔNG được bịa số liệu, bịa nguồn, hay tự ước tính để lấp chỗ trống.
5. Mọi thông tin PHẢI kèm URL nguồn THẬT trong trường "sourceUrl" — lấy đúng URL của trang bạn đã đọc được thông tin đó (từ đoạn trích được cung cấp, hoặc từ kết quả tìm kiếm web thật của bạn). TUYỆT ĐỐI KHÔNG được bịa URL hay tự nghĩ ra tên nguồn không kiểm chứng được.
6. Với "hygroscopicity" và "polymorphs": đọc DỮ LIỆU KHẢ NĂNG HÚT ẨM và DỮ LIỆU THÙ HÌNH TINH THỂ bên dưới (kết quả tìm kiếm Google cho đúng cụm từ "${drugName} moisture-absorbing capacity" và "${drugName} các dạng thù hình tinh thể"), sau đó TỰ TỔNG HỢP một đoạn tóm tắt ngắn gọn (giống phong cách "AI Overview" của Google: nêu kết luận chính trước, kèm 1-2 chi tiết bổ sung) dựa trên các nguồn đó — không copy nguyên văn, viết lại bằng lời của bạn nhưng phải trung thực với nội dung nguồn, và bắt buộc ghi "sourceUrl" là URL nguồn cụ thể bạn đã dùng.
7. Với polymorph: chỉ mô tả các dạng đã được công bố, ghi rõ DOI (https://doi.org/...) hoặc URL cụ thể.
8. VIẾT NGẮN GỌN: mỗi "value" tối đa 1-2 câu ngắn, KHÔNG chèn markdown link hay chú thích [1][2] vào trong "value" — chỉ đặt URL sạch vào đúng trường "sourceUrl".
9. BẮT BUỘC áp dụng quy tắc trích dẫn (rule 5) cho TẤT CẢ các trường trong mục "physical" không trừ trường nào — bao gồm "hygroscopicity". Trường này KHÔNG được mặc định để "sourceUrl": null; chỉ để null sau khi đã tìm kiếm web thật mà không ra kết quả.
10. Trả lời bằng tiếng Việt. Đầu ra CUỐI CÙNG phải là JSON hợp lệ, KHÔNG có markdown, KHÔNG có text nào khác ngoài JSON.`,
      },
      {
        role: 'user',
        content: `Phân tích dược chất "${drugName}".

DỮ LIỆU ĐÃ XÁC MINH TỪ API (sử dụng trực tiếp, không thay đổi giá trị):
${verifiedText || '(Không lấy được từ API)'}

DỮ LIỆU TÍNH CHẤT VẬT LÝ (Google Search — nhiệt độ nóng chảy, độ tan):
${physSnippets || '(Không có dữ liệu bổ sung)'}

DỮ LIỆU BỔ SUNG TỪ DRUGBANK (Google Search):
${dbSnippets || '(Không có dữ liệu DrugBank)'}

DỮ LIỆU THÙ HÌNH TINH THỂ (Google Search — "${drugName} các dạng thù hình tinh thể"):
${polymorphSnippets || '(Không có dữ liệu thù hình)'}

DỮ LIỆU KHẢ NĂNG HÚT ẨM (Google Search — "${drugName} moisture-absorbing capacity"):
${hygroSnippets || '(Không có dữ liệu hút ẩm)'}

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
    "appearance": {"value": "Cảm quan: màu sắc, trạng thái (bột/tinh thể...)", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Physical-Description` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"},
    "solubility": {"value": "Độ tan trong nước và các dung môi, độ tan trong các môi trường pH khác nhau (nếu có)", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Solubility` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"},
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
    },
    "meltingPoint": {"value": "Nhiệt độ nóng chảy °C", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Melting-Point` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"},
    "hygroscopicity": {"value": "Tóm tắt ngắn gọn kiểu AI Overview về khả năng hút ẩm, dựa trên DỮ LIỆU KHẢ NĂNG HÚT ẨM bên dưới hoặc web search", "sourceUrl": "URL nguồn thật bạn đã dùng để tổng hợp — chỉ để null nếu tìm kiếm web thật cũng không ra"}
  },
  "chemical": {
    "pka": {"value": "Giá trị pKa", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Dissociation-Constants` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"},
    "acidBaseNature": {"value": "Tính Acid hay Base dựa trên pKa và cấu trúc hóa học (chỉ nêu kết luận rút ra được từ dữ liệu pKa đã có, không tự suy diễn nếu không có pKa)", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Dissociation-Constants` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"}
  },
  "biological": {
    "logP": {"value": "Giá trị LogP lấy từ PubChem", "sourceUrl": "${cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}#section=Octanol-Water-Partition-Coefficient` : `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(drugName)}`}"},
    "bcsClass": {"value": "Phân loại BCS Class I/II/III/IV dựa trên DỮ LIỆU BCS", "sourceUrl": "Mã DOI hoặc URL từ bài báo trong DỮ LIỆU BCS"}
  }
}`,
      }
    ], 'openai/gpt-5-nano:online');

    updateProgress(searchId, 'aiAnalysis', 95, 'Đang biên dịch kết quả phân tích AI...');
    const deepseekPoly = await deepseekPolyPromise;
    try {
      const parsed = safeParseJSON(text);
      // Ghi đè polymorphs bằng kết quả DeepSeek (đọc kỹ nhiều nguồn thật) nếu gọi thành công
      if (deepseekPoly && typeof deepseekPoly === 'object') {
        deepseekPoly.imageUrl = polymorphImage || null;
        deepseekPoly.images = polymorphImages;
        parsed.physical = parsed.physical || {};
        parsed.physical.polymorphs = deepseekPoly;
      }
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


app.post('/api/forced-degradation', requireApprovedUser, async (req, res) => {
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

    // Thay vì cắt N ký tự đầu bài (dễ bỏ lỡ phần Results nằm sau Methods/Introduction),
    // trích riêng 3 phần Abstract / Preparation-Methods / Results dựa trên tiêu đề mục trong văn bản.
    // Nếu không nhận diện được cấu trúc mục rõ ràng, fallback về lấy đoạn đầu như cũ.
    function extractKeySections(text, maxLen = 9000) {
      if (!text) return '';
      const lower = text.toLowerCase();
      const findFrom = (patterns, fromIdx) => {
        let best = -1;
        for (const p of patterns) {
          const idx = lower.indexOf(p, fromIdx);
          if (idx !== -1 && (best === -1 || idx < best)) best = idx;
        }
        return best;
      };
      const abstractIdx = findFrom(['abstract'], 0);
      const methodsIdx = findFrom(
        ['materials and methods', 'experimental section', 'preparation of', 'methodology', 'experimental'],
        abstractIdx >= 0 ? abstractIdx + 8 : 0
      );
      const resultsIdx = findFrom(['results and discussion', 'results'], methodsIdx >= 0 ? methodsIdx + 8 : 0);
      let endIdx = -1;
      if (resultsIdx >= 0) {
        endIdx = findFrom(['conclusion', 'discussion', 'references', 'acknowledg'], resultsIdx + 500);
      }

      const parts = [];
      if (abstractIdx >= 0) {
        const stop = methodsIdx > abstractIdx ? methodsIdx : abstractIdx + 2500;
        parts.push(text.slice(abstractIdx, Math.min(stop, abstractIdx + 2500)));
      }
      if (methodsIdx >= 0) {
        const stop = resultsIdx > methodsIdx ? resultsIdx : methodsIdx + 3500;
        parts.push(text.slice(methodsIdx, Math.min(stop, methodsIdx + 3500)));
      }
      if (resultsIdx >= 0) {
        const stop = endIdx > resultsIdx ? endIdx : resultsIdx + 6000;
        parts.push(text.slice(resultsIdx, Math.min(stop, resultsIdx + 6000)));
      }
      const combined = parts.join('\n[...]\n');
      return combined.length > 200 ? combined.slice(0, maxLen) : text.slice(0, maxLen);
    }

    // Giữ nguyên số lượng bài đọc (không cắt giảm) — chỉ tập trung đọc đúng 3 phần
    // Abstract / Preparation-Methods / Results của từng bài để tiết kiệm ngữ cảnh mà không bỏ sót số liệu.
    const aiPapers = sortedPapers.slice(0, 30);

    const paperContext = aiPapers.length
      ? aiPapers.map((p, i) => `[Tài liệu ${i + 1}]
Tiêu đề: ${p.title}
Nguồn: ${p.url}
Abstract/Snippet: ${p.abstract.slice(0, 1000)}
Nội dung chính (Abstract/Methods/Results): ${extractKeySections(p.body)}`).join('\n\n---\n\n')
      : '';

    const systemMsg = `Bạn là một trợ lý tra cứu dữ liệu khoa học thực nghiệm, đọc rất kỹ và cẩn thận. Bạn KHÔNG ĐƯỢC PHÉP sử dụng kiến thức có sẵn trong bộ nhớ để tự suy đoán hoặc giải thích.
BƯỚC 1: SÀNG LỌC VÀ ĐỐI CHIẾU DỮ LIỆU
- Kiểm tra xem tài liệu được cung cấp có thực sự nghiên cứu về hoạt chất mục tiêu hay không. NẾU KHÔNG, LOẠI BỎ NGAY.
- ĐỌC KỸ TOÀN BỘ "Nội dung chính" của TỪNG tài liệu (không chỉ đọc Abstract/Snippet) — dữ liệu thực nghiệm cụ thể (nồng độ, nhiệt độ, thời gian, % phân hủy) thường nằm sâu trong phần kết quả/bảng biểu của bài báo, không phải trong abstract. Đọc từng tài liệu ít nhất 2 lượt trước khi kết luận thiếu dữ liệu.
- CHÚ Ý ĐẶC BIỆT các bảng kết quả dạng "Table X: Force/Forced Degradation Results" hoặc có cột "%Undegraded"/"% phân hủy"/"Degradation (%)". Vì nội dung PDF được chuyển sang văn bản thuần nên bảng thường bị mất căn chỉnh cột — các con số (VD: 80, 81.5, 9.2, 76, 91) có thể nằm rời rạc ngay sau hoặc gần dòng mô tả điều kiện tương ứng (VD: "Reflux for 2h with 0.5M HCl" rồi tới số "80" ngay sau — đó chính là % còn lại/chưa phân hủy của điều kiện acid). Hãy suy luận cẩn thận để khớp đúng số liệu với điều kiện tương ứng dựa trên thứ tự xuất hiện, KHÔNG bỏ qua các bảng chỉ vì bị mất định dạng.
- Chỉ giữ lại các thông số thực nghiệm RÕ RÀNG: nồng độ chất thử (VD: HCl 1M), nhiệt độ (VD: 60°C), thời gian, và tên tạp chất/sản phẩm phân hủy thực tế.
- Nếu đã đọc kỹ toàn bộ nội dung mà tài liệu vẫn không có thông tin về một điều kiện cụ thể, hãy ghi rõ: "Không tìm thấy dữ liệu thực nghiệm công bố cho điều kiện này". Tuyệt đối không tự điền thông tin lý thuyết.
BƯỚC 2: TRÍCH XUẤT VÀ ĐÍNH KÈM NGUỒN
Trình bày kết quả theo đúng cấu trúc JSON được yêu cầu. Mọi thông tin BẮT BUỘC phải có nguồn gốc từ tài liệu.
BƯỚC 3: DỊCH SANG TIẾNG VIỆT
Tài liệu nguồn thường bằng tiếng Anh — BẮT BUỘC dịch toàn bộ nội dung trích xuất (conditions, rate, products, mechanism, overview, conclusion...) sang tiếng Việt chuyên ngành dược trước khi điền vào JSON, KHÔNG để nguyên văn tiếng Anh (trừ trường "quote" — trích dẫn nguyên văn giữ nguyên ngôn ngữ gốc).`;

    const userMsg = papers.length
      ? `Đọc kỹ TOÀN BỘ các tài liệu liên quan dưới đây (bao gồm cả phần "Nội dung chính" đầy đủ, không chỉ tóm tắt) về pH ổn định và phân hủy cưỡng bức của "${drugName}" (LƯU Ý: Chú ý ĐÀO THẢI những bài báo không tập trung vào ${drugName}):\n\n${paperContext}\n\nLập báo cáo. MỖI điều kiện cần ghi rõ Thông số thực nghiệm, Kết quả thu được và Nguồn trích dẫn. Trả về JSON:`
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
BẮT BUỘC phải trích dẫn tên tài liệu hoặc nguồn tham khảo khoa học mà bạn đã học được.
BẮT BUỘC viết TOÀN BỘ nội dung (bao gồm "range" và "details") bằng tiếng Việt, kể cả khi nguồn tham khảo gốc là tiếng Anh — chỉ giữ nguyên tiếng Anh cho "quote" (trích dẫn nguyên văn) nếu có.
Trả về định dạng JSON hợp lệ KHÔNG dùng markdown.`;
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
      ], 'deepseek/deepseek-chat'),
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

// ── Route: Tóm tắt 1 bài báo cụ thể theo yêu cầu (dùng DeepSeek, đọc kỹ) ──────
app.post('/api/summarize-paper', requireApprovedUser, async (req, res) => {
  const { url, title, drugName } = req.body;
  const openaiKey = req.body.openaiKey || process.env.OPENAI_API_KEY;
  if (!openaiKey) return res.status(400).json({ error: 'Thiếu OpenAI API key' });
  if (!url) return res.status(400).json({ error: 'Thiếu URL bài báo' });

  try {
    const body = await fetchText(url, title || '');
    let text;
    const detailRules = `Trả lời bằng tiếng Việt, dạng đoạn văn thuần (không markdown, không JSON, không dùng dấu * hay #), viết CHI TIẾT và ĐẦY ĐỦ (không rút gọn quá mức), chia thành 3 phần rõ ràng, mỗi phần cách nhau 1 dòng trống, mỗi phần ghi rõ tiêu đề bằng chữ thường kèm dấu hai chấm ở đầu dòng:

Phương pháp thử nghiệm: mô tả cách người ta tiến hành thí nghiệm — chuẩn bị mẫu, phương pháp phân tích (HPLC/UV-Vis/LC-MS...), điều kiện cột sắc ký, pha động, bước sóng, thiết bị sử dụng (nếu bài báo có nêu).

Điều kiện thử độ ổn định: liệt kê CỤ THỂ từng điều kiện thử (acid, kiềm, oxy hóa, nhiệt, quang, thủy phân) mà bài báo đã thực hiện — nồng độ tác nhân, nhiệt độ, thời gian thử nghiệm cho từng điều kiện.

Kết quả độ ổn định: nêu CỤ THỂ kết quả thu được cho từng điều kiện đã thử — % phân hủy, sản phẩm phân hủy phát hiện được, kết luận về độ ổn định/độ nhạy cảm của hoạt chất với từng điều kiện.

Nếu bài báo không đề cập một phần nào, ghi rõ "Không tìm thấy thông tin về [phần đó] trong bài báo" — KHÔNG bịa đặt hay dùng kiến thức nội bộ để lấp chỗ trống.`;

    if (body && body.length > 300) {
      // Đã lấy được nội dung thật của trang/PDF — để DeepSeek đọc kỹ trực tiếp nội dung này.
      text = await callOpenAI(openaiKey, [
        {
          role: 'system',
          content: `Bạn là chuyên gia hóa dược, đọc rất kỹ tài liệu khoa học. TUYỆT ĐỐI KHÔNG bịa đặt hay dùng kiến thức nội bộ — chỉ tóm tắt đúng nội dung được cung cấp.
Nếu tài liệu không thực sự liên quan đến hoạt chất "${drugName}" hoặc không có dữ liệu độ ổn định/phân hủy cưỡng bức, hãy nêu rõ điều đó thay vì bịa ra thông tin.
${detailRules}`,
        },
        {
          role: 'user',
          content: `Tiêu đề bài báo: ${title || '(không rõ)'}\nURL: ${url}\n\nNội dung bài báo:\n${body.slice(0, 20000)}\n\nHãy đọc thật kỹ và tóm tắt chi tiết các thông tin về độ ổn định/phân hủy cưỡng bức của "${drugName}" trong bài báo này.`,
        },
      ], 'deepseek/deepseek-chat');
    } else {
      // Không tải được nội dung trực tiếp (trang có thể chặn truy cập tự động, vd ResearchGate/PubMed)
      // — để DeepSeek tự tìm kiếm & đọc bài báo này qua web search thật.
      text = await callOpenAI(openaiKey, [
        {
          role: 'system',
          content: `Bạn là chuyên gia hóa dược, có khả năng tìm kiếm web thời gian thực. TUYỆT ĐỐI KHÔNG bịa đặt — chỉ dùng thông tin đọc được thật từ bài báo.
QUAN TRỌNG: Hệ thống đã thử tải trực tiếp trang này nhưng KHÔNG thành công (trang có thể chặn truy cập tự động, ví dụ ResearchGate/Elsevier/PubMed thường chặn bot). Hãy TỰ tìm kiếm và cố đọc lại bài báo này qua công cụ web search của bạn.
Nếu bạn CŨNG không truy cập/đọc được nội dung đầy đủ, hãy ghi rõ: "Không thể tự động tải nội dung đầy đủ của trang này (có thể do trang chặn truy cập tự động) — vui lòng mở link để xem trực tiếp." KHÔNG được ghi kiểu "bài báo không đề cập" nếu lý do thực sự là không truy cập được trang, vì đó là 2 tình huống khác nhau — nếu bạn có tìm thấy tiêu đề/abstract dù không đọc được toàn văn thì cứ tóm tắt phần đó và nêu rõ giới hạn.
${detailRules}`,
        },
        {
          role: 'user',
          content: `Tìm và đọc thật kỹ bài báo sau: "${title || url}" (${url}). Tóm tắt chi tiết các thông tin về độ ổn định/phân hủy cưỡng bức của "${drugName}" trong bài báo này.`,
        },
      ], 'deepseek/deepseek-chat:online');
    }
    res.json({ summary: text, url, fetchFailed: !(body && body.length > 300) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function normalizeDosageForm(form) {
  if (!form) return { vi: '', en: '', ru: '' };
  const f = form.toLowerCase().trim();
  // Viên sủi PHẢI kiểm tra TRƯỚC "viên nén" vì "effervescent tablet" có chứa chữ "tablet" —
  // nếu để sau sẽ bị nhận nhầm thành viên nén thường (mất đặc tính sủi).
  if (f.includes('sủi') || f.includes('effervescent') || f.includes('шипучие')) {
    return { vi: 'Viên sủi', en: 'Effervescent tablet', ru: 'шипучие таблетки' };
  }
  if (f.includes('nén') || f.includes('tablet') || f.includes('таблетки')) {
    return { vi: 'Viên nén', en: 'Tablet', ru: 'таблетки' };
  }
  if (f.includes('nang') || f.includes('capsule') || f.includes('капсулы')) {
    return { vi: 'Viên nang', en: 'Capsule', ru: 'капсулы' };
  }
  // Thuốc nhỏ mắt / nhãn khoa — kiểm tra TRƯỚC "hỗn dịch"/"dung dịch" vì nhỏ mắt có thể là dung dịch
  // hoặc hỗn dịch; dùng "en" bao trùm nhiều biến thể để bộ lọc patent nhận diện đúng.
  if (f.includes('nhỏ mắt') || f.includes('eye drop') || f.includes('ophthalmic') || f.includes('nhãn khoa') || f.includes('глазные')) {
    return { vi: 'Thuốc nhỏ mắt', en: 'Eye drops / Ophthalmic (solution/suspension)', ru: 'глазные капли' };
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
  // Dạng khác không nằm trong danh sách trên: nếu chuỗi có phần tiếng Anh trong ngoặc "(...)" thì
  // dùng phần đó làm "en" (tránh query tìm kiếm bị lẫn tiếng Việt), phần trước ngoặc làm "vi".
  const enMatch = form.match(/\(([^)]+)\)/);
  const viPart = form.replace(/\s*\([^)]*\)\s*/, ' ').trim();
  return { vi: viPart || form, en: enMatch ? enMatch[1].trim() : form, ru: form };
}

// ── Route: Vidal.ru Formulas (Thay thế SRA) ───────────────────────────────────────────────

// Chọn tối đa 3 công thức "đầy đủ" (có hàm lượng cụ thể cho phần lớn tá dược) và dùng AI viết
// QUY TRÌNH SẢN XUẤT từng bước cho mỗi công thức, DỰA TRÊN VAI TRÒ của từng tá dược.
async function buildSuggestedFormulas(openaiKey, drugName, dosageForm, normalized, products) {
  const hasNum = (v) => v && /\d/.test(String(v));
  const scored = products
    .map((p) => {
      const exs = (p.excipients || []).filter((e) => e && typeof e === 'object');
      const withAmt = exs.filter((e) => hasNum(e.amount)).length;
      return { p, total: exs.length, frac: exs.length ? withAmt / exs.length : 0 };
    })
    .filter((x) => x.total >= 2 && x.frac >= 0.6) // đủ tá dược + phần lớn có hàm lượng cụ thể
    .sort((a, b) => b.frac - a.frac || b.total - a.total)
    .slice(0, 3)
    .map((x) => x.p);
  if (scored.length === 0) return [];

  const system = `Bạn là chuyên gia bào chế dược phẩm Việt Nam. Với MỖI công thức được cung cấp (đã có đầy đủ hoạt chất, tá dược, hàm lượng và VAI TRÒ của từng tá dược), hãy viết QUY TRÌNH SẢN XUẤT/PHA CHẾ chi tiết TỪNG BƯỚC, DỰA TRÊN VAI TRÒ của từng tá dược trong công thức.

NGUYÊN TẮC VIẾT QUY TRÌNH THEO DẠNG BÀO CHẾ:
- VIÊN NÉN — PHẢI TỰ CHỌN PHƯƠNG PHÁP TẠO HẠT PHÙ HỢP dựa trên tính chất hoạt chất và tá dược có trong công thức, và NÊU RÕ tên phương pháp đã chọn ở bước đầu:
  * XÁT HẠT ƯỚT (wet granulation) — dùng khi công thức CÓ tá dược dính dạng dung dịch (Povidon/PVP, hồ tinh bột, HPMC...) và hoạt chất KHÔNG kỵ ẩm/kỵ nhiệt:
    1. Trộn đều hoạt chất với tá dược độn và tá dược rã (rã trong).
    2. Pha tá dược dính: hòa tan tá dược dính trong dung môi (nước/ethanol).
    3. Nhào ẩm khối bột với dung dịch tá dược dính, xát hạt qua rây (vd rây 1,25 mm).
    4. Sấy hạt ở 40–50°C đến khi độ ẩm đạt 2–4%.
    5. Sửa hạt qua rây.
    6. Trộn ngoài với tá dược trơn/chống dính và tá dược rã ngoài.
    7. Dập viên tới khối lượng/độ cứng quy định.
  * TẠO HẠT KHÔ (dry granulation — dập slug hoặc nén con lăn/roller compaction) — ƯU TIÊN dùng khi hoạt chất KỴ ẨM hoặc KỴ NHIỆT (không sấy được), hoặc công thức KHÔNG có tá dược dính dạng dung dịch, hoặc là viên sủi/hoạt chất dễ thủy phân:
    1. Trộn đều hoạt chất với tá dược độn, tá dược dính khô và tá dược rã (rã trong).
    2. Trộn với một phần tá dược trơn để chống dính chày cối khi dập slug/nén con lăn.
    3. Dập thành viên to (slug) hoặc nén qua trục lăn (roller compaction) tạo tấm/dải.
    4. Xay/phá vỡ slug và xát hạt qua rây tới cỡ hạt quy định.
    5. Trộn ngoài với tá dược trơn/chống dính và tá dược rã ngoài.
    6. Dập viên tới khối lượng/độ cứng quy định.
  * DẬP THẲNG (direct compression) — dùng khi tá dược đều thuộc loại dập thẳng được (cellulose vi tinh thể, lactose phun sấy, dicalci phosphat...) và không cần tạo hạt:
    1. Rây và trộn đều hoạt chất với tá dược độn dập thẳng và tá dược rã.
    2. Trộn ngoài với tá dược trơn/chống dính.
    3. Dập viên tới khối lượng/độ cứng quy định.
  Với MỌI phương pháp: nếu công thức có hệ bao phim → viết thêm quy trình dịch bao phim ở "coatingProcess". Ở bước đầu tiên PHẢI ghi rõ phương pháp đã chọn và LÝ DO ngắn gọn (vd: "Chọn tạo hạt khô do esomeprazol kỵ ẩm/kỵ nhiệt").
- DỊCH BAO PHIM (chỉ khi công thức có tá dược tạo màng như PVA/HPMC/hypromellose/Opadry):
  1. Phân tán polymer tạo màng trong phần lớn (vd 60%) lượng nước tinh khiết → dung dịch A.
  2. Hòa tan chất hóa dẻo (PEG/Macrogol/glycerin) trong một phần nước rồi phối vào A.
  3. Phân tán chất màu, titan dioxyd, talc trong lượng nước còn lại rồi phối vào A.
  4. Khuấy đều 45–60 phút → dịch bao phim; lọc qua rây.
  5. Tiến hành bao phim.
- VIÊN NANG: trộn hoạt chất + tá dược độn/trơn/rã; (xát hạt nếu cần); đóng nang.
- HỖN DỊCH/DUNG DỊCH: hòa tan/phân tán hoạt chất và tá dược theo thứ tự hợp lý (chất bảo quản, chất tạo hỗn dịch/tạo đặc, chất điều chỉnh pH, chất tạo ngọt/điều hương...); lọc; đóng chai.
- THUỐC TIÊM: pha vô trùng, hòa tan hoạt chất + tá dược đẳng trương/điều chỉnh pH; lọc vô khuẩn (0,22 µm); đóng ống/lọ; tiệt khuẩn.
- THUỐC MỠ/KEM/GEL: chuẩn bị pha dầu & pha nước (nếu là kem/nhũ tương); đun chảy/phối trộn, đồng nhất hóa; thêm hoạt chất; khuấy tới đồng nhất.
Với dạng bào chế KHÁC không liệt kê ở trên, viết quy trình tương tự theo nguyên tắc bào chế đặc trưng của dạng đó.

YÊU CẦU:
- Mỗi bước gồm: "action" (nội dung thao tác cụ thể, PHẢI nhắc TÊN tá dược và vai trò của nó) và "control" (thông số kiểm soát nếu có: nhiệt độ, độ ẩm, thời gian, cỡ rây, tốc độ khuấy...; nếu không có để chuỗi rỗng "").
- "process" = quy trình pha chế chính (vd pha chế viên). "coatingProcess" = quy trình pha chế dịch bao phim; nếu công thức KHÔNG có hệ bao phim thì để mảng rỗng [].
- TUYỆT ĐỐI KHÔNG bịa thêm tá dược không có trong công thức. Chỉ dùng đúng các tá dược & vai trò đã cho.
- Toàn bộ tiếng Việt chuyên ngành dược. TUYỆT ĐỐI KHÔNG nhắc tới nguồn gốc quốc gia (không viết "Nga", "Vidal"...).
- TRẢ VỀ JSON hợp lệ KHÔNG markdown, mảng "formulas" theo ĐÚNG THỨ TỰ công thức được cung cấp.

JSON:
{ "formulas": [ { "process": [ {"action":"...","control":"..."} ], "coatingProcess": [ {"action":"...","control":"..."} ] } ] }`;

  const userContent = scored.map((p, i) => {
    const exLines = (p.excipients || [])
      .map((e) => `   - ${e.name}: ${e.amount || 'vừa đủ'} [vai trò: ${e.role || 'chưa rõ'}]`)
      .join('\n');
    return `[Công thức ${i + 1}]\nTên: ${p.productName || ''}\nHoạt chất: ${p.activeIngredient || drugName}${p.strength ? ' — ' + p.strength : ''}\nDạng bào chế: ${p.dosageForm || dosageForm}\nTá dược:\n${exLines}`;
  }).join('\n\n');

  try {
    const text = await callOpenAI(openaiKey, [
      { role: 'system', content: system },
      { role: 'user', content: `Dạng bào chế mục tiêu: ${dosageForm} (${normalized.en}).\n\n${userContent}\n\nHãy xuất JSON quy trình cho ${scored.length} công thức theo đúng thứ tự trên:` }
    ], 'deepseek/deepseek-chat', 3, 16000);
    const parsed = safeParseJSON(text);
    const procs = Array.isArray(parsed.formulas) ? parsed.formulas : [];
    return scored.map((p, i) => ({
      productName: p.productName || '',
      productNameEn: p.productNameEn || '',
      activeIngredient: p.activeIngredient || '',
      strength: p.strength || '',
      dosageForm: p.dosageForm || dosageForm,
      excipients: p.excipients || [],
      process: (procs[i] && Array.isArray(procs[i].process)) ? procs[i].process : [],
      coatingProcess: (procs[i] && Array.isArray(procs[i].coatingProcess)) ? procs[i].coatingProcess : [],
    }));
  } catch (e) {
    console.error('buildSuggestedFormulas error:', e.message);
    return scored.map((p) => ({
      productName: p.productName || '', productNameEn: p.productNameEn || '', activeIngredient: p.activeIngredient || '',
      strength: p.strength || '', dosageForm: p.dosageForm || dosageForm, excipients: p.excipients || [],
      process: [], coatingProcess: [],
    }));
  }
}

app.post('/api/sra-formulas', requireApprovedUser, async (req, res) => {
  const { drugName, dosageForm, searchId } = req.body;
  const openaiKey = req.body.openaiKey || process.env.OPENAI_API_KEY;
  if (!drugName || !dosageForm) return res.status(400).json({ error: 'Thiếu tên hoạt chất hoặc dạng bào chế' });
  if (!openaiKey) return res.status(400).json({ error: 'Thiếu OpenAI API key' });

  updateProgress(searchId, 'vidal', 5, 'Khởi động tiến trình tra cứu công thức Nga...');

  try {
    const normalized = normalizeDosageForm(dosageForm);
    const cheerio = require('cheerio');
    // Helper: axios GET với retry khi bị 429
    const axiosRetry = async (url, opts, maxRetries = 3) => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await axios.get(url, opts);
        } catch (e) {
          if (e.response && e.response.status === 429 && attempt < maxRetries - 1) {
            const waitSec = (attempt + 1) * 3; // 3s, 6s, 9s
            console.log(`[Vidal] 429 rate limit, retrying in ${waitSec}s... (${attempt + 1}/${maxRetries})`);
            await delay(waitSec * 1000);
          } else {
            throw e;
          }
        }
      }
    };
    const vidalHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

    // 1. Tìm kiếm trên Vidal.ru (có retry)
    updateProgress(searchId, 'vidal', 10, 'Đang truy vấn công thức trên Vidal.ru...');
    const searchUrl = `https://www.vidal.ru/search?q=${encodeURIComponent(drugName)}`;
    const searchRes = await axiosRetry(searchUrl, { headers: vidalHeaders, timeout: 15000 });
    
    const $ = cheerio.load(searchRes.data);
    const links = [];
    const filteredLinks = [];
    const ruKeyword = normalized.ru.toLowerCase();
    const keywords = ruKeyword.split('/');
    const drugLower = drugName.toLowerCase();

    $('.products-table tr').each((i, row) => {
      const nameEl = $(row).find('.products-table-name a');
      if (nameEl.length === 0) return; // skip header
      
      const zipText = $(row).find('.products-table-zip').text().trim().toLowerCase();
      const titleText = nameEl.text().trim();
      const url = 'https://www.vidal.ru' + nameEl.attr('href');
      
      links.push({ title: titleText, url });

      // Clean keyword check: dùng 5 ký tự đầu làm gốc so khớp (vd: "таблетки" -> "таблет")
      const isMatch = keywords.some(kw => {
        const stem = kw.length > 5 ? kw.slice(0, 5) : kw;
        return zipText.includes(stem);
      });

      if (isMatch) {
        // Đánh dấu nếu là đơn chất (tên trùng hoặc chứa chính xác tên hoạt chất)
        const isMono = titleText.toLowerCase() === drugLower || titleText.toLowerCase().includes(drugLower);
        filteredLinks.push({ title: titleText, url, isMono });
      }
    });

    if (links.length === 0) {
      updateProgress(searchId, 'vidal', 100, 'Không tìm thấy sản phẩm nào.');
      return res.json({ products: [], totalProducts: 0, dataSource: 'Vidal.ru (Nga)' });
    }

    // Ưu tiên dùng các link đã lọc theo dạng bào chế
    let targetLinks = filteredLinks;
    if (targetLinks.length === 0) {
      targetLinks = links; // Fallback dùng all links nếu lọc không ra
    }

    // Sắp xếp đưa thuốc đơn chất (mono-preparation) lên trước
    targetLinks.sort((a, b) => (b.isMono ? 1 : 0) - (a.isMono ? 1 : 0));

    // Chạy toàn bộ sản phẩm tìm được, không giới hạn số lượng.
    const productData = [];
    const chunkSize = 3;
    const chunks = [];
    for (let i = 0; i < targetLinks.length; i += chunkSize) {
      chunks.push(targetLinks.slice(i, i + chunkSize));
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const processedCount = i * chunkSize;
      updateProgress(searchId, 'vidal', 20 + Math.round((processedCount / targetLinks.length) * 60), `Đang tải chi tiết sản phẩm: ${processedCount}/${targetLinks.length}...`);
      
      await Promise.all(chunk.map(async (link) => {
        try {
          const detailRes = await axiosRetry(link.url, { headers: vidalHeaders, timeout: 15000 });
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
      await delay(1500); // Nghỉ 1.5s sau mỗi batch để tránh 429
    }

    // 3. Sử dụng AI để dịch và lọc theo dạng bào chế
    // Không còn giới hạn số sản phẩm -> chia nhỏ thành từng lô (batch) để gọi AI song song,
    // tránh 1 lệnh gọi duy nhất phải sinh ra JSON quá dài (dễ bị cắt cụt/lỗi parse khi có nhiều sản phẩm).
    updateProgress(searchId, 'vidal', 80, 'Đang gửi dữ liệu tiếng Nga tới OpenAI để dịch...');
    const BATCH_SIZE = 8;
    const productBatches = [];
    for (let i = 0; i < productData.length; i += BATCH_SIZE) {
      productBatches.push(productData.slice(i, i + BATCH_SIZE));
    }

    const aiSystem = `Bạn là chuyên gia bào chế và phiên dịch Dược phẩm Nga. Nhiệm vụ:
1. Đọc các bản ghi thành phần từ Vidal.ru.
2. LỌC: CHỈ giữ lại các sản phẩm khớp với dạng bào chế mục tiêu.
   Dạng bào chế mục tiêu được định nghĩa là: Tiếng Việt: "${normalized.vi}", Tiếng Anh: "${normalized.en}", Tiếng Nga: "${normalized.ru}". Bỏ qua các sản phẩm không khớp.
3. DỊCH TOÀN BỘ TÊN THÀNH PHẦN SANG TIẾNG VIỆT CHUYÊN NGÀNH DƯỢC (theo đúng Dược điển Việt Nam), VÀ PHÂN TÍCH VAI TRÒ TÁ DƯỢC:
   - QUY TRÌNH DỊCH BẮT BUỘC (2 bước SUY NGHĨ NỘI BỘ — nhưng trường "name" ở JSON đầu ra CHỈ ĐƯỢC chứa kết quả CUỐI CÙNG của Bước 2, TUYỆT ĐỐI KHÔNG được để tên tiếng Anh/quốc tế trong trường "name"):
     Bước 1 (nội bộ, không xuất ra): Từ tên tiếng Nga (thường là phiên âm/tương đương của tên quốc tế INN hoặc dược điển), NHẬN DIỆN tên quốc tế (INN/tiếng Anh/tiếng Latin) của hoạt chất/tá dược đó. Ví dụ: "лактозы моногидрат" → "Lactose monohydrate"; "повидон" → "Povidone (PVP)"; "магния стеарат" → "Magnesium stearate"; "тальк" → "Talc"; "кросповидон" → "Crospovidone".
     Bước 2 (BẮT BUỘC XUẤT RA trong trường "name"): Từ tên quốc tế đó, dịch sang đúng thuật ngữ TIẾNG VIỆT chuẩn theo Dược điển Việt Nam / danh pháp dược phẩm Việt Nam hiện hành. Bảng ví dụ tên cuối cùng PHẢI dùng đúng dạng tiếng Việt như sau: "Lactose monohydrate"→"Lactose monohydrat"; "Magnesium stearate"→"Magnesi stearat"; "Sodium starch glycolate"→"Natri starch glycolat"; "Povidone"→"Povidon"; "Talc"→"Talc"; "Crospovidone"→"Crospovidon"; "Microcrystalline cellulose"→"Cellulose vi tinh thể"; "Colloidal silicon dioxide"→"Silic dioxyd keo"; "Titanium dioxide"→"Titan dioxyd"; "Hypromellose"→"Hypromellose (HPMC)"; "Corn starch"→"Tinh bột ngô/bắp"; "Calcium stearate"→"Calci stearat"; "Macrogol/PEG"→"Macrogol/PEG" (giữ nguyên, đã là tên chuẩn VN). Với tên thương mại lớp bao phim (ví dụ "Opadry..."), giữ nguyên tên thương mại KHÔNG dịch.
     TUYỆT ĐỐI KHÔNG dịch nghĩa đen sai chuyên ngành, KHÔNG để lẫn ký tự ngôn ngữ khác (Trung/Nga) trong trường "name", KHÔNG viết mơ hồ/chung chung.
   - Dịch tên Hoạt chất (activeIngredient) sang tiếng Việt theo đúng quy trình trên — trường "activeIngredient" CHỈ chứa tên tiếng Việt.
   - Dịch TẤT CẢ các thành phần tá dược (вспомогательные вещества) theo đúng quy trình trên — trường "name" của MỌI tá dược CHỈ chứa tên tiếng Việt (trừ tên thương mại lớp bao phim giữ nguyên như quy định ở trên).
   - Đối với mỗi tá dược, hãy dùng kiến thức AI chuyên sâu của bạn về hóa dược để phân tích vai trò cụ thể của nó trong công thức này (ví dụ: Tá dược rã, Tá dược dính, Tá dược trơn, Tá dược độn, Chất điều hương, Chất bảo quản, Tá dược bao, v.v.).
   - PHẢI GIỮ NGUYÊN HÀM LƯỢNG VÀ SỐ LƯỢNG (nếu có trong dữ liệu gốc tiếng Nga, ví dụ: "25,5 mg"). Nếu không có hàm lượng cụ thể, để là "N/A" hoặc "vừa đủ".
   - TÁCH BIỆT RÕ RÀNG: Tuyệt đối không để lẫn hàm lượng/số lượng bên trong trường "name" (tên tá dược). Tên tá dược phải sạch (ví dụ: "lactose monohydrat"), còn hàm lượng phải được đưa riêng vào trường "amount" (ví dụ: "100 mg" hoặc "vừa đủ").
   - Nếu không chắc chắn về tên quốc tế của 1 thành phần tiếng Nga, GIỮ NGUYÊN tên tiếng Nga gốc kèm ghi chú "(chưa xác định được tên quốc tế)" thay vì đoán bừa/dịch sai.
4. TỔNG HỢP & ĐỀ XUẤT:
   - "commonExcipients": Liệt kê các tá dược được dùng phổ biến nhất trong các công thức Ở LÔ NÀY.
   - "formulationInsights": Nhận xét chuyên môn về xu hướng tá dược & cách phối hợp công thức. TUYỆT ĐỐI KHÔNG nhắc tới nguồn gốc quốc gia (không viết "từ Nga", "của Nga", "Vidal"...), chỉ nhận xét thuần chuyên môn dược.
5. YÊU CẦU BẮT BUỘC (CRITICAL): BẠN PHẢI TRẢ VỀ TOÀN BỘ TẤT CẢ CÁC SẢN PHẨM Ở LÔ NÀY KHỚP VỚI DẠNG BÀO CHẾ VÀ CÓ THÔNG TIN TÁ DƯỢC. Sản phẩm nào không đọc được thành phần tá dược (excipients rỗng) thì BỎ QUA, không đưa vào "products". TUYỆT ĐỐI KHÔNG ĐƯỢC LƯỢC BỎ, RÚT GỌN các sản phẩm CÓ đầy đủ tá dược.
6. TRẢ VỀ JSON hợp lệ KHÔNG dùng markdown.
Cấu trúc JSON:
{
  "products": [
    {
      "productName": "Tên sản phẩm tiếng Nga (giữ nguyên gốc)",
      "productNameEn": "Tên sản phẩm dịch/phiên âm sang tiếng Anh (ví dụ: 'Ибупрофен + Парацетамол' -> 'Ibuprofen + Paracetamol'; nếu là tên thương mại riêng không có nghĩa dịch được thì phiên âm Latin, ví dụ 'Нурофен' -> 'Nurofen')",
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
      "route": "Đường dùng",
      "source": "Vidal.ru",
      "sourceUrl": "URL gốc"
    }
  ],
  "commonExcipients": ["Tá dược A", "Tá dược B"],
  "formulationInsights": "Đoạn văn nhận xét và đề xuất công thức..."
}`;

    updateProgress(searchId, 'vidal', 85, `Đang dịch ${productData.length} sản phẩm qua ${productBatches.length} lô...`);
    const batchResults = await Promise.all(productBatches.map(async (batch) => {
      const promptData = batch.map((p, i) => `[Sản phẩm ${i + 1}]\nTên: ${p.title}\nURL: ${p.url}\nThành phần (Tiếng Nga): ${p.text}`).join('\n\n');
      try {
        const text = await callOpenAI(openaiKey, [
          { role: 'system', content: aiSystem },
          { role: 'user', content: `Hoạt chất mục tiêu: ${drugName}\nDạng bào chế mục tiêu: ${dosageForm}\n\nDữ liệu tiếng Nga (${batch.length} sản phẩm):\n${promptData}\n\nHãy xuất JSON:` }
        ], 'deepseek/deepseek-chat', 3, 12000);
        return safeParseJSON(text);
      } catch (e) {
        console.error('Lỗi dịch 1 lô sản phẩm Vidal:', e.message);
        return { products: [], commonExcipients: [], formulationInsights: '' };
      }
    }));

    updateProgress(searchId, 'vidal', 95, 'Đang gộp kết quả các lô...');
    // Bỏ các sản phẩm không có thông tin tá dược (dữ liệu không đầy đủ để tham khảo công thức).
    const allProducts = batchResults.flatMap(r => r.products || []).filter(p => Array.isArray(p.excipients) && p.excipients.length > 0);
    const excipientSet = new Map(); // key thường hóa (lowercase) -> tên gốc, để khử trùng lặp
    for (const r of batchResults) {
      for (const ex of (r.commonExcipients || [])) {
        const key = String(ex).toLowerCase().trim();
        if (key && !excipientSet.has(key)) excipientSet.set(key, ex);
      }
    }
    const formulationInsights = batchResults.map(r => r.formulationInsights).find(Boolean) || '';

    // 4. ĐỀ XUẤT CÔNG THỨC: chọn tối đa 3 công thức đầy đủ thành phần + hàm lượng tá dược,
    //    dùng AI viết quy trình sản xuất từng bước cho mỗi công thức dựa trên vai trò tá dược.
    updateProgress(searchId, 'vidal', 97, 'Đang đề xuất công thức & viết quy trình sản xuất...');
    const suggestedFormulas = await buildSuggestedFormulas(openaiKey, drugName, dosageForm, normalized, allProducts);

    updateProgress(searchId, 'vidal', 100, 'Hoàn thành.');
    res.json({
      products: allProducts,
      totalProducts: allProducts.length,
      dataSource: 'Vidal.ru',
      commonExcipients: Array.from(excipientSet.values()),
      formulationInsights,
      suggestedFormulas
    });
  } catch (err) {
    console.error('Vidal Error:', err);
    updateProgress(searchId, 'vidal', 100, 'Lỗi tiến trình.');
    res.status(500).json({ error: err.message });
  }
});

// ── Route: Patents ────────────────────────────────────────────────────────────

// Trích các phần trọng yếu của patent để đọc sâu mà không phải nạp toàn văn rất dài:
//  - Đoạn đầu (Abstract/Field) làm bối cảnh.
//  - Vùng BACKGROUND + SUMMARY OF THE INVENTION (chứa "vấn đề cần xử lý" + "tóm tắt phát minh").
//  - Phần EXAMPLES (chứa công thức/thông số thực nghiệm cụ thể nhất).
function extractPatentSections(text, maxLen = 26000) {
  if (!text) return '';
  const lower = text.toLowerCase();
  const findFirst = (patterns, fromIdx = 0) => {
    let best = -1;
    for (const p of patterns) {
      const idx = lower.indexOf(p, fromIdx);
      if (idx !== -1 && (best === -1 || idx < best)) best = idx;
    }
    return best;
  };
  const exampleIdx = findFirst(['examples', 'example 1', 'working example', 'exemplary formulation']);
  const claimsIdx = findFirst(['we claim', 'what is claimed', 'i claim'], exampleIdx >= 0 ? exampleIdx + 200 : 0);

  const parts = [text.slice(0, 6000)];

  // Vùng Background/Summary (nơi nêu vấn đề cần giải quyết + tóm tắt phát minh) nếu nằm ngoài 6000 ký tự đầu.
  const bgIdx = findFirst(['background of the invention', 'background art', 'field of the invention', 'summary of the invention', 'object of the invention', 'disadvantage']);
  if (bgIdx > 6000 && (exampleIdx < 0 || bgIdx < exampleIdx)) {
    parts.push('\n[--- BỐI CẢNH & TÓM TẮT PHÁT MINH ---]\n' + text.slice(bgIdx, bgIdx + 5000));
  }

  if (exampleIdx >= 0) {
    const stop = claimsIdx > exampleIdx ? claimsIdx : exampleIdx + 15000;
    parts.push('\n[--- PHẦN VÍ DỤ (EXAMPLES) ---]\n' + text.slice(exampleIdx, Math.min(stop, exampleIdx + 15000)));
  } else {
    parts.push(text.slice(6000, 16000));
  }
  return parts.join('\n').slice(0, maxLen);
}

// Tìm kiếm TRỰC TIẾP qua API công khai (không cần đăng nhập) của chính patents.google.com — ổn định
// và cho nhiều kết quả thật hơn hẳn so với việc đi vòng qua Serper (Serper hay chặn cú pháp site: cho
// riêng domain này). Mỗi trang trả về 10 kết quả; gọi song song nhiều trang để lấy đủ số lượng cần.
async function fetchGooglePatentsPage(query, page, retries = 2) {
  const urlParam = `q=${encodeURIComponent(query)}&page=${page}`;
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(`https://patents.google.com/xhr/query?url=${encodeURIComponent(urlParam)}&exp=`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' },
        timeout: 15000,
      });
    } catch (e) {
      if (i === retries - 1) throw e;
      await delay(1200 * (i + 1)); // API nội bộ này thỉnh thoảng trả 503 khi gọi dồn dập — chờ rồi thử lại
    }
  }
}

async function searchGooglePatentsDirect(query, numPages = 3) {
  // Gọi TUẦN TỰ (không song song) từng trang kèm khoảng nghỉ nhỏ — tránh bị 503 do gọi dồn dập
  // vào 1 API nội bộ không chính thức của Google Patents.
  const pages = [];
  for (let page = 0; page < numPages; page++) {
    try {
      pages.push({ status: 'fulfilled', value: await fetchGooglePatentsPage(query, page) });
    } catch (e) {
      pages.push({ status: 'rejected', reason: e });
    }
    if (page < numPages - 1) await delay(400);
  }
  const results = [];
  for (const p of pages) {
    if (p.status !== 'fulfilled') continue;
    const clusters = p.value.data?.results?.cluster || [];
    for (const c of clusters) {
      for (const r of (c.result || [])) {
        const patent = r.patent;
        if (!patent || !r.id) continue;
        results.push({
          title: (patent.title || '').replace(/\s+/g, ' ').trim(),
          link: `https://patents.google.com/${r.id}`,
          // patents.google.com (trang chi tiết) hay chặn bot (503); PDF gốc được lưu trên domain
          // tĩnh riêng (patentimages.storage.googleapis.com), KHÔNG bị chặn — ưu tiên đọc PDF này.
          pdfUrl: patent.pdf ? `https://patentimages.storage.googleapis.com/${patent.pdf}` : null,
          snippet: (patent.snippet || '').replace(/&hellip;/g, '...').replace(/\s+/g, ' ').trim(),
          publicationNumber: patent.publication_number || '',
          assignee: (patent.assignee || '').trim(),
          filingDate: patent.filing_date || '',
          publicationDate: patent.publication_date || '',
        });
      }
    }
  }
  return results;
}

// Tìm kiếm bổ sung qua WIPO PatentScope (nguồn độc lập với Google Patents/Serper, mở rộng tổng số
// patent thật tìm được). LƯU Ý: trang danh sách kết quả có nội dung thật đọc được ngay, nhưng trang
// CHI TIẾT patent của WIPO cần JavaScript để hiển thị nội dung (không đọc được qua HTTP GET đơn
// thuần) — nên các patent từ nguồn này chỉ dùng để mở rộng danh sách khám phá (title/số patent/ngày
// thật), không đọc sâu tự động được như patents.google.com.
async function searchWipoPatentscope(query, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const cheerio = require('cheerio');
      const res = await axios.get(`https://patentscope.wipo.int/search/en/result.jsf?query=${encodeURIComponent(query)}`, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      });
      // WIPO chặn IP truy vấn dồn dập bằng trang CAPTCHA (psCaptchaForm) — status vẫn 200 nhưng 0 kết quả.
      // Phân biệt rõ trường hợp bị chặn để thử lại (backoff) và log đúng bản chất, thay vì tưởng "hết patent".
      if (/psCaptchaForm|ps-no-content/i.test(res.data)) {
        if (i === retries - 1) { console.error('searchWipoPatentscope: bị WIPO chặn tạm thời (CAPTCHA).'); return []; }
        await delay(2000 * (i + 1));
        continue;
      }
      const $ = cheerio.load(res.data);
      const results = [];
      $('.ps-patent-result').each((idx, el) => {
        const $el = $(el);
        const pubNumber = $el.find('.ps-patent-result--title--patent-number').first().text().trim();
        const title = $el.find('.ps-patent-result--title--title').first().text().trim();
        const country = $el.find('.ps-patent-result--title--ctr-pubdate .notranslate').first().text().trim();
        const href = $el.find('a[href*="detail.jsf"]').first().attr('href');
        if (!pubNumber || !href) return;
        results.push({
          title: title || pubNumber,
          link: `https://patentscope.wipo.int/search/en/${href.replace(/&amp;/g, '&')}`,
          snippet: `${country ? country + ' — ' : ''}${title}`.trim(),
          publicationNumber: pubNumber,
        });
      });
      return results;
    } catch (e) {
      if (i === retries - 1) {
        console.error('searchWipoPatentscope error:', e.message);
        return [];
      }
      await delay(1000 * (i + 1));
    }
  }
  return [];
}

// Chấm điểm mức độ khớp của patent với hoạt chất/dạng bào chế đang tìm, để chọn ra top 5 đọc sâu.
function scorePatentRelevance(doc, drugName, normalized) {
  const hay = `${doc.title} ${doc.snippet} ${doc.body.slice(0, 3000)}`.toLowerCase();
  let score = 0;
  if (hay.includes(drugName.toLowerCase())) score += 3;
  if (normalized.en && hay.includes(normalized.en.toLowerCase())) score += 2;
  if (doc.body && doc.body.length > 2000) score += 2;
  if (doc.body && /\bexample\b/i.test(doc.body)) score += 2;
  return score;
}

app.post('/api/patents', requireApprovedUser, async (req, res) => {
  const { drugName, dosageForm, searchId } = req.body;
  const openaiKey = req.body.openaiKey || process.env.OPENAI_API_KEY;
  const serperKey = req.body.serperKey || process.env.SERPER_API_KEY;
  if (!openaiKey) return res.status(400).json({ error: 'Thiếu API key' });

  updateProgress(searchId, 'patents', 5, 'Khởi động tiến trình tra cứu patent...');

  try {
    const normalized = normalizeDosageForm(dosageForm);
    // Từ khóa dạng bào chế NGẮN GỌN cho truy vấn tìm kiếm (cắt bỏ phần "/(...)" để tránh ký tự đặc
    // biệt làm hỏng query — vd "Eye drops / Ophthalmic (solution/suspension)" -> "Eye drops").
    const formKeyword = (normalized.en || '').split(/[\/(]/)[0].trim();
    updateProgress(searchId, 'patents', 15, 'Đang tìm kiếm trên Google Patents...');
    // 3 nguồn tìm kiếm chạy song song, bổ trợ lẫn nhau:
    // - Google Patents (API nội bộ): đọc được PDF gốc; nhưng chặn IP máy chủ khi truy vấn dồn dập.
    // - WIPO PatentScope: nguồn độc lập; cũng có thể chặn IP bằng CAPTCHA khi truy vấn dồn dập.
    // - Serper (truy vấn THƯỜNG, KHÔNG dùng cú pháp site: và KHÔNG dùng dấu ngoặc kép — cả 2 đều bị gói
    //   free từ chối 400): cào từ máy chủ của Serper nên KHÔNG dính giới hạn IP của máy chủ này — là nguồn
    //   ỔN ĐỊNH NHẤT, luôn chạy được kể cả khi 2 nguồn kia bị chặn. Gói free trả ~9 kết quả/truy vấn nên
    //   chạy NHIỀU truy vấn nhắm patent khác nhau để gom được nhiều patent thật (đã kiểm chứng ~10 patent).
    // Dùng allSettled để 1 nguồn lỗi không làm hỏng các nguồn còn lại.
    const serperSearchRetry = async (query, num, retries = 2) => {
      if (!serperKey) return { organic: [] };
      for (let i = 0; i < retries; i++) {
        try { return await serperSearch(query, serperKey, num); }
        catch (e) { if (i === retries - 1) return { organic: [] }; await delay(1200 * (i + 1)); }
      }
    };
    // Serper (gói free) trả ~9 kết quả/truy vấn -> chạy NHIỀU truy vấn ở nhiều góc độ khác nhau để gom
    // được nhiều patent DUY NHẤT nhất, đặc biệt quan trọng khi Google Patents/WIPO đang bị chặn IP.
    const serperQueries = [
      `${drugName} ${formKeyword} patent formulation composition`.trim(),
      `${drugName} patent formulation examples excipients`.trim(),
      `${drugName} pharmaceutical composition patent US`.trim(),
      `${drugName} ${formKeyword} preparation method patent WO`.trim(),
      `${drugName} ${formKeyword} patent google patents`.trim(),
      `${drugName} ${formKeyword} sustained release patent`.trim(),
      `${drugName} ${formKeyword} immediate release patent`.trim(),
      `${drugName} ${formKeyword} patent CN preparation method`.trim(),
      `${drugName} ${formKeyword} patent EP coating granule`.trim(),
      `${drugName} patent stability excipient tablet`.trim(),
    ];
    const settled = await Promise.allSettled([
      searchGooglePatentsDirect(`${drugName} ${formKeyword}`.trim(), 5),
      searchWipoPatentscope(`${drugName} ${formKeyword}`.trim()),
      searchWipoPatentscope(`${drugName} pharmaceutical composition formulation`.trim()),
      ...serperQueries.map((q) => serperSearchRetry(q, 20)),
    ]);
    const directResults = settled[0].status === 'fulfilled' ? settled[0].value : [];
    const wipoResults = [
      ...(settled[1].status === 'fulfilled' ? settled[1].value : []),
      ...(settled[2].status === 'fulfilled' ? settled[2].value : []),
    ];
    const serperResults = settled.slice(3).flatMap((s) => (s.status === 'fulfilled' ? (s.value?.organic || []) : []));
    console.log(`[patents] nguồn: direct=${directResults.length} wipo=${wipoResults.length} serper=${serperResults.length}`);

    // Gộp tất cả nguồn, chỉ giữ link thật sự thuộc trang patent, khử trùng lặp theo URL.
    const patentDomainRe = /patents\.google\.com|espacenet\.com|freepatentsonline\.com|uspto\.gov|patentscope\.wipo\.int/i;
    const seen = new Set();
    const unique = [...directResults, ...wipoResults, ...serperResults].filter((r) => {
      if (!r.link || !patentDomainRe.test(r.link)) return false;
      if (seen.has(r.link)) return false;
      seen.add(r.link);
      return true;
    });

    if (unique.length === 0) {
      // KHÔNG được để AI tự bịa patent khi không có tài liệu thật nào — trả về rỗng và báo lỗi tìm kiếm rõ ràng.
      // Cả 2 nguồn cùng trả rỗng thường là do bị giới hạn tốc độ/chặn tạm thời (Google Patents & WIPO chặn
      // IP máy chủ khi truy vấn dồn dập) chứ không hẳn là "không có patent" — báo đúng bản chất để người dùng thử lại.
      updateProgress(searchId, 'patents', 100, 'Không lấy được patent (có thể bị chặn tạm thời).');
      return res.json({
        patents: [], otherPatents: [], rawLinks: [],
        error: 'Chưa lấy được patent nào lúc này. Nguồn Google Patents/WIPO có thể đang tạm giới hạn tốc độ truy vấn từ máy chủ. Vui lòng thử lại sau vài phút. (Nếu lặp lại nhiều lần, hãy kiểm tra lại tên hoạt chất.)',
      });
    }

    // KHÔNG còn tự động đọc sâu 5 patent nữa — trả về TẤT CẢ patent tìm được dưới dạng danh sách;
    // người dùng bấm nút "DeepSeek tóm tắt" cho patent nào cần (tra cứu nhanh hơn nhiều, không phải
    // tải nội dung 30 patent + gọi AI ngay). pdfUrl (nếu có từ Google Patents) được giữ để khi tóm tắt
    // ưu tiên đọc PDF gốc.
    const allPatents = unique.map((r) => ({ title: r.title, url: r.link, pdfUrl: r.pdfUrl || null, snippet: r.snippet }));
    updateProgress(searchId, 'patents', 100, 'Hoàn thành.');
    return res.json({
      patents: [],
      otherPatents: allPatents,
      rawLinks: allPatents,
      totalFound: allPatents.length,
    });
  } catch (err) {
    updateProgress(searchId, 'patents', 100, 'Lỗi tiến trình.');
    res.status(500).json({ error: err.message });
  }
});

// ── Route: Tóm tắt 1 patent cụ thể theo yêu cầu (dùng DeepSeek, đọc kỹ) ──────
app.post('/api/summarize-patent', requireApprovedUser, async (req, res) => {
  const { url, title, pdfUrl, drugName, dosageForm } = req.body;
  const openaiKey = req.body.openaiKey || process.env.OPENAI_API_KEY;
  if (!openaiKey) return res.status(400).json({ error: 'Thiếu OpenAI API key' });
  if (!url) return res.status(400).json({ error: 'Thiếu URL patent' });

  try {
    const normalized = normalizeDosageForm(dosageForm);
    // Ưu tiên đọc PDF gốc (domain tĩnh, không bị chặn bot) nếu có; nếu không mới thử trang HTML.
    let body = '';
    if (pdfUrl) {
      try { body = await fetchPdf(pdfUrl) || ''; } catch (e) { /* fallback bên dưới */ }
    }
    if (!body) {
      try { body = await fetchText(url, title || '') || ''; } catch (e) { /* để trống */ }
    }
    // "Nội dung tốt" = đủ dài VÀ có dấu hiệu chứa phần mô tả/ví dụ/công thức (không phải trang lỗi/trống).
    // Chỉ khi có nội dung tốt mới đọc offline (nhanh, đầy đủ từ PDF); còn lại BẮT BUỘC dùng :online để
    // DeepSeek tự truy cập URL patent + tra web đọc bảng công thức (đã kiểm chứng DeepSeek :online đọc
    // đúng bảng Examples của patent). Đây là điểm sửa: trước đây ngưỡng 300 ký tự quá thấp, đôi khi
    // trang lỗi/1 phần vẫn lọt qua và bị đọc offline thiếu bảng công thức -> báo "không tìm được".
    const hasGoodContent = body && body.length > 1500 && /example|composition|excipient|mg|tablet|формул|компози/i.test(body);
    const summarizeModel = hasGoodContent ? 'deepseek/deepseek-chat' : 'deepseek/deepseek-chat:online';
    const content = hasGoodContent
      ? `Nội dung: ${extractPatentSections(body)}`
      : `(Không tải trực tiếp được đầy đủ nội dung patent này. BẮT BUỘC: hãy TỰ TRUY CẬP trực tiếp URL ${url} (và tra cứu web) để ĐỌC nội dung thật của patent, ĐẶC BIỆT đọc kỹ BẢNG CÔNG THỨC trong phần Examples/Table và phần Background/Summary. TUYỆT ĐỐI KHÔNG bịa số liệu — nếu vẫn không đọc được thì mới ghi rõ không đọc được.)`;

    const text = await callOpenAI(openaiKey, [
      {
        role: 'system',
        content: `Bạn là chuyên gia phân tích patent dược phẩm, đọc RẤT KỸ và viết tóm tắt CHI TIẾT, CHUYÊN SÂU (KHÔNG được sơ sài). TUYỆT ĐỐI KHÔNG BỊA ĐẶT — chỉ dùng thông tin đọc được thật.
Nếu patent không thực sự về dạng bào chế "${normalized.vi}" (${normalized.en}) hoặc không đọc được nội dung, hãy nêu rõ điều đó.
Bản tóm tắt BẮT BUỘC gồm đủ 4 phần sau, mỗi phần viết đầy đủ nhiều câu, có số liệu cụ thể khi patent có nêu:
1. VẤN ĐỀ CỦA HOẠT CHẤT CẦN XỬ LÝ (problemStatement): Patent này ra đời để giải quyết vấn đề/nhược điểm gì của hoạt chất hoặc công thức trước đó? (vd: độ tan kém, sinh khả dụng thấp, kém ổn định/dễ thủy phân, vị đắng, hút ẩm, khó nén, giải phóng không kiểm soát...). Nêu rõ bối cảnh kỹ thuật (Background) và mục tiêu phát minh.
2. TÓM TẮT PHÁT MINH (inventionSummary): Tóm tắt phần "Summary of the Invention" — giải pháp cốt lõi mà patent đề xuất (loại tá dược/kỹ thuật/tỷ lệ đặc trưng) và cách nó khắc phục vấn đề ở mục 1.
3. VÍ DỤ MINH HỌA & PHƯƠNG PHÁP ĐÁNH GIÁ (examplesSummary + selectionMethod): Đọc sâu phần Examples — tóm tắt các công thức thử nghiệm kèm thông số cụ thể; và nêu rõ các PHƯƠNG PHÁP/TIÊU CHÍ ĐÁNH GIÁ dùng để so sánh (độ hòa tan, độ cứng, độ rã, độ ổn định, sinh khả dụng...).
4. CÔNG THỨC TỐI ƯU & PHƯƠNG PHÁP BÀO CHẾ (optimalFormula + manufacturingProcess): Trích công thức tối ưu (Preferred Embodiment) kèm hàm lượng/tỷ lệ từng thành phần, và quy trình bào chế chi tiết TỪNG BƯỚC (kèm thông số nhiệt độ/thời gian/cỡ rây nếu có).
Patent gốc thường bằng tiếng Anh — BẮT BUỘC dịch TOÀN BỘ nội dung sang tiếng Việt chuyên ngành dược, KHÔNG để nguyên văn tiếng Anh (trừ tên hóa chất/tá dược quốc tế không có bản dịch chuẩn). JSON hợp lệ KHÔNG markdown.`,
      },
      {
        role: 'user',
        content: `Đọc kỹ patent "${title || url}" (${url}) của "${drugName}", dạng bào chế mục tiêu: "${normalized.vi}" (${normalized.en}).\n${content}\n\nTrả về JSON (viết CHI TIẾT, KHÔNG sơ sài):
{
  "patentNumber": "US/EP/WO số...",
  "title": "Tiêu đề",
  "applicant": "Công ty",
  "filingDate": "Ngày nộp",
  "url": "${url}",
  "dosageForm": "Dạng bào chế",
  "problemStatement": "Vấn đề/nhược điểm của hoạt chất hoặc công thức trước mà patent nhắm giải quyết + bối cảnh kỹ thuật và mục tiêu.",
  "inventionSummary": "Tóm tắt phần Summary of the Invention — giải pháp cốt lõi patent đề xuất.",
  "composition": {
    "activeIngredient": "Hoạt chất + hàm lượng",
    "excipients": ["Tá dược + lượng/vai trò"],
    "examplesSummary": "Tóm tắt CHI TIẾT các ví dụ (Examples) kèm thông số + các phương pháp/tiêu chí đánh giá được dùng.",
    "selectionMethod": "Phương pháp/tiêu chí đánh giá để chọn công thức tối ưu (độ hòa tan, độ cứng, độ ổn định...).",
    "optimalFormula": "- Hoạt chất X: 100mg\\n- Tá dược Y: 50mg\\n...",
    "manufacturingProcess": "1. Bước 1...\\n2. Bước 2...",
    "innovativeFeatures": "Điểm đổi mới"
  },
  "claims": "Claims chính"
}`,
      },
    ], summarizeModel, 3, 20000);

    const parsed = safeParseJSON(text);
    res.json(parsed);
  } catch (err) {
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
  
  const fs = require('fs');
  const path = require('path');
  const localPath = path.join(__dirname, 'pharmacopoeia_data.json');

  try {
    console.log('[Pharmacopoeia] Fetching data from webofpharma.com...');
    const res = await axios.get('https://www.webofpharma.com/2025/08/pharmacopoeia-search-engine.html', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' }
    });
    const html = res.data;
    const match = html.match(/const pharmacopoeiaData\s*=\s*(\[[\s\S]*?\]);\s*(?:\/\/|function|const|let|var|document|\n\s*\n)/);
    if (match) {
      const vm = require('vm');
      _pharmacoData = vm.runInNewContext(match[1]);
      _pharmacoFetchedAt = now;
      console.log(`[Pharmacopoeia] Loaded ${_pharmacoData.length} entries from Web.`);
      fs.writeFile(localPath, JSON.stringify(_pharmacoData, null, 2), 'utf8', () => {});
      return _pharmacoData;
    }
  } catch (e) {
    console.warn('[Pharmacopoeia] Web request failed, falling back to local file:', e.message);
  }

  // Fallback đọc file cục bộ
  if (fs.existsSync(localPath)) {
    try {
      const localData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      _pharmacoData = localData;
      _pharmacoFetchedAt = now;
      console.log(`[Pharmacopoeia] Loaded ${_pharmacoData.length} entries from local JSON fallback.`);
      return _pharmacoData;
    } catch (err) {
      console.error('[Pharmacopoeia] Error parsing local JSON file:', err.message);
    }
  }

  throw new Error('Không thể tải dữ liệu dược điển từ cả máy chủ trực tuyến và bản sao lưu cục bộ.');
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
app.post('/api/compatibility', requireApprovedUser, async (req, res) => {
  const { drugName, smiles, searchId } = req.body;
  if (!drugName) return res.status(400).json({ error: 'Thiếu tên hoạt chất' });

  updateProgress(searchId, 'compatibility', 10, 'Bắt đầu kiểm tra tương tác hoạt chất - tá dược...');

  let targetSmiles = smiles;

  // 1. Nếu chưa có SMILES, tìm kiếm trên PubChem
  if (!targetSmiles) {
    try {
      updateProgress(searchId, 'compatibility', 30, 'Đang tìm kiếm cấu trúc SMILES của hoạt chất trên PubChem...');
      const pcRes = await axios.get(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(drugName)}/property/CanonicalSMILES,IsomericSMILES/JSON`, { timeout: 15000 });
      const prop = pcRes.data?.PropertyTable?.Properties?.[0];
      if (prop) {
        targetSmiles = prop.CanonicalSMILES || prop.IsomericSMILES;
      }
      // Fallback: thử tìm CID trước rồi lấy SMILES
      if (!targetSmiles) {
        try {
          const cidRes = await axios.get(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(drugName)}/cids/JSON`, { timeout: 10000 });
          const cid = cidRes.data?.IdentifierList?.CID?.[0];
          if (cid) {
            const smiRes = await axios.get(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/CanonicalSMILES/JSON`, { timeout: 10000 });
            targetSmiles = smiRes.data?.PropertyTable?.Properties?.[0]?.CanonicalSMILES;
          }
        } catch (e2) {
          console.error('[Compatibility] PubChem CID fallback error:', e2.message);
        }
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
    // PharmDE là máy chủ ngoài, đôi khi phản hồi chậm — thử lại 2 lần. Nếu cả 2 lần đều timeout thì
    // nhiều khả năng server PharmDE đang sập/quá tải (không phụ thuộc vào code hay phân tử tra cứu).
    let pharmRes;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        pharmRes = await axios.get(url, {
          timeout: 40000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        break;
      } catch (e) {
        if (attempt === 1) {
          const isTimeout = /timeout/i.test(e.message) || e.code === 'ECONNABORTED' || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT';
          if (isTimeout) {
            updateProgress(searchId, 'compatibility', 100, 'Máy chủ PharmDE không phản hồi.');
            return res.status(503).json({ error: 'Máy chủ PharmDE (bên thứ ba) hiện không phản hồi — có thể đang bảo trì/quá tải. Đây không phải lỗi của hoạt chất bạn tra. Vui lòng thử lại sau ít phút.' });
          }
          throw e;
        }
        updateProgress(searchId, 'compatibility', 60, 'PharmDE phản hồi chậm, đang thử lại (2/2)...');
        await delay(2000);
      }
    }

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
        ], 'openai/gpt-5-nano', 2);
        
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

app.post('/api/pharmacopoeia/search', requireApprovedUser, async (req, res) => {
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

app.post('/api/pharmacopoeia/standards', requireApprovedUser, async (req, res) => {
  const { drugName, dosageForm, selectedMonograph, openaiKey, searchId } = req.body;
  if (!drugName || !dosageForm || !selectedMonograph) {
    return res.status(400).json({ error: 'Thiếu tên hoạt chất, dạng bào chế hoặc monograph được chọn' });
  }
  const apiKey = openaiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Thiếu OpenAI API key' });

  try {
    updateProgress(searchId, 'pharmaStandards', 8, 'Đang tải chuyên luận dược điển...');
    let monographText = '';
    if (selectedMonograph.pdfUrl) {
      console.log(`[Pharmacopoeia] Fetching and parsing PDF monograph: ${selectedMonograph.pdfUrl}`);
      monographText = await fetchPdf(selectedMonograph.pdfUrl);
    }
    updateProgress(searchId, 'pharmaStandards', 25, 'Đang xây dựng bảng tiêu chuẩn & danh mục hóa chất...');

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
      "chiTieu": "Tính chất",
      "yeuCau": "Viên nén, màu ..., cạnh viên lành lặn",
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
0. CHỈ đưa vào các CHỈ TIÊU KIỂM NGHIỆM (chỉ tiêu chất lượng có phép thử + tiêu chí chấp nhận), ví dụ: Tính chất, Định tính, Đồng đều khối lượng, Đồng đều hàm lượng, Định lượng, Độ hòa tan, Tạp chất liên quan, Giới hạn nhiễm khuẩn, pH, Nước/mất khối lượng do làm khô... TUYỆT ĐỐI KHÔNG đưa vào bảng các mục KHÔNG PHẢI chỉ tiêu kiểm nghiệm như: "Bao gói và bảo quản" (Packaging/Storage), "Tiêu chuẩn tham chiếu"/"Chất đối chiếu" (USP Reference Standards), "Ghi nhãn" (Labeling), "Định nghĩa" (Definition), "Bảo quản" (Storage). Những mục này KHÔNG được xuất hiện dưới dạng một dòng chỉ tiêu.
1. CHỈ đưa vào các chỉ tiêu THỰC SỰ được quy định cụ thể trong chuyên luận Monograph của Dược điển được chọn. Nếu chuyên luận không có chỉ tiêu nào thì KHÔNG đưa chỉ tiêu đó vào bảng.
2. TUYỆT ĐỐI KHÔNG tự bịa ra các chỉ tiêu hoặc thông số không có trong chuyên luận Monograph đó. Ví dụ: Các chuyên luận viên nén của USP/BP/EP thường KHÔNG quy định chỉ tiêu Độ cứng (Hardness) và Độ mài mòn (Friability) trong chuyên luận riêng. Do đó, nếu chuyên luận Monograph được chọn không ghi các chỉ tiêu này, bạn TUYỆT ĐỐI KHÔNG được đưa chúng vào bảng tiêu chuẩn.
3. Cột "yeuCau" (Yêu cầu) phải ghi NGẮN GỌN — CHỈ nêu GIỚI HẠN/TIÊU CHÍ CHẤP NHẬN, KHÔNG mô tả dài dòng cả quy trình thử. Với chỉ tiêu cần phương pháp thử theo dược điển thì chỉ ghi ngắn gọn kiểu "Thử theo phụ lục ..." như dược điển ghi. Mẫu văn phong ngắn gọn cần theo:
   - Tính chất: "Viên nén, màu ..., cạnh viên lành lặn; không bị gãy vỡ, bở vụn."
   - Định tính: "Cho phản ứng dương tính của [tên hoạt chất]."
   - Đồng đều khối lượng: "Đạt yêu cầu Phép thử đồng đều khối lượng." (hoặc "Thử theo phụ lục ...")
   - Định lượng: "[Hoạt chất]: 90,0% - 110,0% so với hàm lượng ghi trên nhãn."
   - Độ hòa tan: "Không ít hơn 75% lượng [hoạt chất] hòa tan trong 45 phút." (theo số liệu thật của monograph)
   - Tạp chất liên quan: "Tạp [tên]: không được quá 0,X%; tổng tạp không quá X%." (theo số liệu thật của monograph)
   Các con số/giới hạn (%, thời gian, CFU, phụ lục...) PHẢI lấy CHÍNH XÁC từ monograph, KHÔNG bịa. Nếu monograph không nêu con số cụ thể thì ghi đúng như dược điển diễn đạt.
4. TUYỆT ĐỐI KHÔNG để lẫn TIẾNG ANH trong bảng (cả cột "Chỉ tiêu" và "Yêu cầu"). PHẢI dịch toàn bộ sang tiếng Việt chuyên ngành dược:
   - Tên chỉ tiêu ghi tiếng Việt, KHÔNG kèm chú thích tiếng Anh trong ngoặc: dùng "Định lượng" (KHÔNG ghi "Định lượng (Assay)"), "Đồng đều hàm lượng" (KHÔNG ghi "(Uniformity of dosage units)"), "Định tính" (KHÔNG ghi "(Identification)").
   - Trong cột Yêu cầu KHÔNG dùng cụm tiếng Anh như "(theo Assay)", "acetaminophen-containing drug products"... — diễn đạt lại hoàn toàn bằng tiếng Việt.
   - Tên hoạt chất dùng tên tiếng Việt theo Dược điển Việt Nam: "acetaminophen" → "Paracetamol"; "caffeine" → "Cafein"; v.v. Chỉ giữ nguyên tên hóa chất/tá dược quốc tế khi KHÔNG có tên tiếng Việt chuẩn.
   - Số chương/phụ lục dược điển (ví dụ USP <905>, <227>) được phép giữ ở dạng số, nhưng phần diễn giải xung quanh phải bằng tiếng Việt (ví dụ: "Đạt yêu cầu phép thử độ đồng đều đơn vị liều theo chuyên luận chung <905>").
   - "Effervescent" → "sủi" (viên nén sủi). KHÔNG dùng viết tắt/thuật ngữ tiếng Anh như "LC", "DAD", "RS", "concordant", "impurity", "assay", "Identity", "Uniformity"... — dịch hết: "LC"→"sắc ký lỏng (HPLC)", "impurity K"→"tạp K", "reference standard/RS"→"chất chuẩn đối chiếu".
5. KHÔNG TRÙNG LẶP — MỖI chỉ tiêu chỉ được xuất hiện ĐÚNG MỘT DÒNG:
   - TUYỆT ĐỐI KHÔNG tạo 2 dòng cho cùng một chỉ tiêu (vd KHÔNG vừa "Định lượng" vừa "Định lượng và công cụ kiểm tra liên quan"; KHÔNG vừa "Định tính" vừa "Định danh (Identity)").
   - GỘP TẤT CẢ các phép thử ĐỊNH TÍNH con (Identification A, B, C...: thời gian lưu theo phép Định lượng, sắc ký lớp mỏng, phổ UV/IR, phản ứng hóa học...) vào DUY NHẤT MỘT dòng "Định tính". Liệt kê các phương pháp con ngắn gọn trong cùng ô Yêu cầu, ngăn cách bằng dấu chấm phẩy hoặc đánh A./B./C. — KHÔNG tách thành nhiều dòng "Định tính bằng ...".
   - Tương tự, gộp các phần con của cùng một chỉ tiêu (vd Tạp chất liên quan có nhiều tạp) vào một dòng duy nhất của chỉ tiêu đó.
   - Nếu một phép thử vừa dùng cho định lượng vừa cho tạp chất, gộp thông tin vào đúng dòng chỉ tiêu tương ứng, không tách thành dòng riêng trùng tên.
6. Cột "Yêu cầu" chỉ ghi tiêu chí chấp nhận ngắn gọn — KHÔNG viết các câu bình luận meta như "nội dung monograph cung cấp bổ sung về...", "ghi nhận giới hạn nếu có trong chuyên luận phụ...". Nếu chuyên luận chính KHÔNG quy định một chỉ tiêu thì BỎ HẲN dòng đó, đừng thêm dòng mô tả mơ hồ.

Điều kiện HPLC (hplcConditions) phải trích xuất chính xác từ phương pháp HPLC quy định trong Monograph được chọn (cho phép thử Định lượng hoặc Tạp chất liên quan).

Danh sách hóa chất (chemicals) phải LIỆT KÊ ĐẦY ĐỦ 100% TOÀN BỘ các hóa chất, dung môi, chất đối chiếu được sử dụng trong tất cả các phương pháp thử nghiệm của chuyên luận đó (ví dụ: các chất đối chiếu chuẩn hoạt chất/tạp chất, dung môi pha động, dung môi pha loãng/pha mẫu, môi trường hòa tan, hóa chất điều chỉnh pH, đệm, thuốc thử định tính...). 
ĐẶC BIỆT LƯU Ý: 
- Đối với dược điển USP và BP, hầu hết các hóa chất đều có dạng liên kết markdown như "[Tên hóa chất](đường link)" (ví dụ: "[methanol](...)", "[USP Acetaminophen RS](...)"). Bạn hãy quét kỹ toàn bộ văn bản để tìm tất cả các liên kết này và đưa tên hóa chất vào danh sách.
- Đối với Dược điển Nhật (JP), châu Âu (EP) hoặc các Dược điển khác, các hóa chất thường KHÔNG có liên kết gạch chân. Do đó, bạn phải đọc cực kỳ cẩn thận toàn bộ văn bản Monograph từ đầu đến cuối (bao gồm cả các phần phụ như Purity, related substances, system suitability, selection of column, detector sensitivity, v.v.) để chủ động phát hiện và trích xuất mọi danh từ chỉ hóa chất, dung môi, chất đối chiếu, chất chuẩn hoặc đệm được nhắc đến.
- BẮT BUỘC PHẢI TRÍCH XUẤT các chất chuẩn đối chiếu phụ hoặc chất dùng cho việc chọn cột/kiểm tra độ phù hợp hệ thống (ví dụ: "4-aminophenol hydrochloride", "hexyl parahydroxybenzoate", "indometacin"...) được nêu trong quy trình.
- Tổng hợp từ cả hai nguồn trên để lập ra danh sách "chemicals" đầy đủ nhất. Tuyệt đối không được bỏ sót bất kỳ hóa chất nào được nhắc đến trong quy trình kiểm nghiệm của Monograph.`;

    const text = await callOpenAI(apiKey, [{ role: 'user', content: prompt }], 'deepseek/deepseek-chat', 3, 16000);
    const parsed = safeParseJSON(text);

    // ── Phương pháp tiến hành: sinh RIÊNG cho TỪNG chỉ tiêu (mỗi chỉ tiêu 1 lệnh gọi) để KHÔNG bị
    // giới hạn token đầu ra (~8k của DeepSeek) làm cắt cụt/rút gọn — bảo đảm dịch ĐẦY ĐỦ toàn bộ
    // quy trình từ dược điển. Chạy song song. Bỏ qua các chỉ tiêu chỉ quan sát cảm quan (không có quy trình).
    const criteria = (parsed.qualityStandards || [])
      .map((s) => s.chiTieu)
      .filter((c) => c && !/tính chất|cảm quan|bao gói|bảo quản|ghi nhãn/i.test(c));
    updateProgress(searchId, 'pharmaStandards', 40, `Đang dịch phương pháp tiến hành (0/${criteria.length} chỉ tiêu)...`);
    let doneCount = 0;
    const methodResults = await Promise.all(criteria.map(async (chiTieu) => {
      try {
        const mText = await callOpenAI(apiKey, [{
          role: 'user',
          content: `Bạn là chuyên gia kiểm nghiệm dược phẩm. Dưới đây là chuyên luận ${selectedMonograph.book} của "${drugName}" (dạng bào chế ${dosageForm}).
Nhiệm vụ: DỊCH NGUYÊN VĂN, ĐẦY ĐỦ, CHI TIẾT toàn bộ QUY TRÌNH TIẾN HÀNH của phép thử/chỉ tiêu "${chiTieu}" sang TIẾNG VIỆT chuyên ngành dược.
YÊU CẦU NGHIÊM NGẶT:
- KHÔNG rút gọn, KHÔNG tóm tắt, KHÔNG bỏ sót BẤT KỲ bước, dung dịch, thông số, điều kiện nào. Phải dịch HẾT: cách pha CHẾ dung dịch chuẩn, dung dịch thử, dung dịch độ phù hợp hệ thống/dung dịch phân giải, dung dịch mẫu trắng; điều kiện tiến hành (thể tích, nồng độ, nhiệt độ, thời gian, môi trường, tốc độ...); tiêu chí ĐỘ PHÙ HỢP HỆ THỐNG (system suitability); công thức/cách TÍNH kết quả; giới hạn bỏ qua (disregard limit) nếu có.
- Giữ CHÍNH XÁC 100% mọi con số, thể tích, nồng độ, thời gian, bước sóng... đúng như dược điển. TUYỆT ĐỐI KHÔNG bịa.
- KHÔNG để lẫn tiếng Anh — dịch hết sang tiếng Việt (chỉ giữ nguyên tên hóa chất/tá dược quốc tế không có tên tiếng Việt chuẩn). Tên hoạt chất dùng tên Dược điển Việt Nam (vd acetaminophen → Paracetamol).
- CHỈ trả về VĂN BẢN THUẦN của quy trình (không JSON, không markdown, không tiêu đề thừa). Nếu chuyên luận không mô tả quy trình cho chỉ tiêu này thì trả về đúng chữ "KHÔNG CÓ".

NỘI DUNG CHUYÊN LUẬN:
${monographText || '(Không trích xuất được PDF — dùng kiến thức dược điển CHÍNH XÁC của bạn về chuyên luận này, tuyệt đối không bịa số liệu.)'}`
        }], 'deepseek/deepseek-chat', 3, 8000);
        const phuongPhap = (mText || '').trim();
        doneCount++;
        updateProgress(searchId, 'pharmaStandards', 40 + Math.round((doneCount / Math.max(criteria.length, 1)) * 58),
          `Đang dịch phương pháp tiến hành (${doneCount}/${criteria.length} chỉ tiêu)...`);
        if (!phuongPhap || /^KHÔNG CÓ\.?$/i.test(phuongPhap)) return null;
        return { chiTieu, phuongPhap };
      } catch (e) {
        doneCount++;
        return null;
      }
    }));
    parsed.testMethods = methodResults.filter(Boolean);

    updateProgress(searchId, 'pharmaStandards', 100, 'Hoàn thành.');
    res.json(parsed);
  } catch (err) {
    console.error('[Pharmacopoeia standards error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`\n🔬 Hỗ trợ nghiên cứu đang chạy tại http://localhost:${PORT}`);
});
server.setTimeout(300000); // 5 minutes
