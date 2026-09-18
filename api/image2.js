const legacy = require('./image');

const MAX_BYTES = 24 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const TIMEOUT_MS = 16000;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function isTildaHost(host) {
  return /(^|\.)(?:tildacdn\.com|tildacdn\.one)$/i.test(String(host || ''));
}
function normalizeTilda(raw) {
  const u = new URL(String(raw));
  if (/^(thb|optim)\.tildacdn\.com$/i.test(u.hostname)) {
    u.hostname = 'static.tildacdn.com';
    u.pathname = u.pathname
      .replace(/\/-\/(?:resize|format|quality|scale_crop|cover)\/[^/]+/gi, '')
      .replace(/\/+/g, '/');
  }
  return u;
}
async function fetchTilda(raw, ref) {
  const u = normalizeTilda(raw);
  if (!['http:', 'https:'].includes(u.protocol) || !isTildaHost(u.hostname)) throw new Error('Не Tilda CDN');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    };
    if (ref) headers.Referer = String(ref);
    let r = await fetch(u.href, { redirect: 'follow', signal: controller.signal, headers });
    if (!r.ok && ref) {
      delete headers.Referer;
      r = await fetch(u.href, { redirect: 'follow', signal: controller.signal, headers });
    }
    if (!r.ok) throw new Error(`Tilda CDN HTTP ${r.status}`);
    const declared = Number(r.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new Error('Изображение слишком большое');
    const body = Buffer.from(await r.arrayBuffer());
    if (!body.length || body.length > MAX_BYTES) throw new Error('Некорректный размер изображения');
    let type = (r.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!type.startsWith('image/')) {
      const head = body.slice(0, 512).toString('utf8').trimStart().toLowerCase();
      if (head.includes('<svg')) type = 'image/svg+xml';
      else if (body[0] === 0x89 && body.slice(1, 4).toString() === 'PNG') type = 'image/png';
      else if (body[0] === 0xff && body[1] === 0xd8) type = 'image/jpeg';
      else if (body.slice(0, 4).toString() === 'RIFF') type = 'image/webp';
      else throw new Error('Tilda CDN вернул не изображение');
    }
    return { body, type, finalUrl: r.url || u.href };
  } finally {
    clearTimeout(timer);
  }
}
async function toPng(src) {
  const mod = await import('sharp');
  const sharp = mod.default || mod;
  let p = sharp(src.body, { failOn: 'none', animated: false, density: src.type === 'image/svg+xml' ? 192 : 72, limitInputPixels: 120_000_000 }).rotate();
  const meta = await p.metadata();
  const w = Number(meta.width || 0), h = Number(meta.height || 0);
  if (!w || !h) throw new Error('Не удалось определить размер изображения');
  if (w > MAX_DIMENSION || h > MAX_DIMENSION) p = p.resize({ width: Math.min(w, MAX_DIMENSION), height: Math.min(h, MAX_DIMENSION), fit: 'inside', withoutEnlargement: true });
  return p.png({ compressionLevel: 8, adaptiveFiltering: true }).toBuffer();
}
function captureRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; return v; },
    send(v) { this.body = v; return v; },
    end(v) { this.body = v; return v; },
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Разрешён только GET' });
  if (String(req.query.ping || '') === '1') return res.status(200).json({ ok: true, service: 'image-normalizer-stable', version: 5 });
  const raw = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  const ref = Array.isArray(req.query.ref) ? req.query.ref[0] : req.query.ref;
  if (!raw) return res.status(400).json({ ok: false, error: 'Не передан параметр url' });

  try {
    const u = new URL(String(raw));
    if (isTildaHost(u.hostname)) {
      try {
        const src = await fetchTilda(String(raw), ref ? String(ref) : '');
        const png = await toPng(src);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
        res.setHeader('X-Image-Source', 'tilda-direct');
        return res.status(200).send(png);
      } catch (directError) {
        const fallbackReq = { ...req, query: { ...req.query, url: normalizeTilda(String(raw)).href } };
        const captured = captureRes();
        await legacy(fallbackReq, captured);
        for (const [k, v] of Object.entries(captured.headers)) res.setHeader(k, v);
        if (captured.statusCode >= 200 && captured.statusCode < 300) return res.status(captured.statusCode).send(captured.body);
        const legacyMsg = captured.body && captured.body.error ? captured.body.error : `HTTP ${captured.statusCode}`;
        throw new Error(`${directError && directError.message ? directError.message : directError}; fallback: ${legacyMsg}`);
      }
    }
    return await legacy(req, res);
  } catch (e) {
    return res.status(502).json({ ok: false, error: e && e.message ? e.message : 'Не удалось загрузить изображение' });
  }
};
