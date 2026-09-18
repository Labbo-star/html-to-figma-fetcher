const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_BYTES = 24 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const MAX_DIMENSION = 4096;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isPrivateV4(ip) {
  const p = String(ip || '').split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function isPrivateV6(ip) {
  const s = String(ip || '').toLowerCase().split('%')[0];
  if (s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || /^fe[89ab]/.test(s)) return true;
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice(7);
    return net.isIP(v4) === 4 ? isPrivateV4(v4) : true;
  }
  return false;
}
function isPrivateIp(ip) {
  const type = net.isIP(ip);
  return type === 4 ? isPrivateV4(ip) : type === 6 ? isPrivateV6(ip) : true;
}

const dnsCache = new Map();
async function assertPublic(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Некорректный URL изображения'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Недопустимый протокол');
  if (url.username || url.password) throw new Error('URL с логином/паролем запрещён');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Локальный адрес запрещён');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Приватный IP запрещён');
    return url;
  }
  let check = dnsCache.get(host);
  if (!check) {
    check = Promise.all([
      dns.resolve4(host).catch(() => []),
      dns.resolve6(host).catch(() => []),
    ]).then(([v4, v6]) => {
      const addresses = [...v4, ...v6];
      return addresses.length > 0 && !addresses.some(isPrivateIp);
    });
    dnsCache.set(host, check);
  }
  if (!(await check)) throw new Error('Адрес изображения не является публичным');
  return url;
}

async function readLimited(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error(`Изображение больше ${Math.round(MAX_BYTES / 1024 / 1024)} МБ`);
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_BYTES) throw new Error('Изображение слишком большое');
    return body;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new Error('Изображение слишком большое');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function fetchImage(raw) {
  let current = await assertPublic(raw);
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current.href, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/149 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Referer': current.origin + '/',
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || i === MAX_REDIRECTS) throw new Error('Слишком много перенаправлений');
      current = await assertPublic(new URL(location, current).href);
      continue;
    }
    if (!response.ok) throw new Error(`Источник изображения вернул HTTP ${response.status}`);
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) throw new Error(`Источник вернул не изображение: ${type || 'неизвестный тип'}`);
    return { type, body: await readLimited(response), finalUrl: current.href };
  }
  throw new Error('Не удалось загрузить изображение');
}

async function normalizeToPng(body, contentType) {
  let sharpMod;
  try {
    sharpMod = await import('sharp');
  } catch (error) {
    throw new Error(`Не удалось загрузить модуль конвертации изображений: ${error && error.message ? error.message : error}`);
  }
  const sharp = sharpMod.default || sharpMod;
  let pipeline;
  try {
    pipeline = sharp(body, {
      failOn: 'none',
      animated: false,
      density: contentType === 'image/svg+xml' ? 192 : 72,
      limitInputPixels: 120_000_000,
    }).rotate();
    const meta = await pipeline.metadata();
    const width = Number(meta.width || 0);
    const height = Number(meta.height || 0);
    if (!width || !height) throw new Error('Не удалось определить размер изображения');
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      pipeline = pipeline.resize({
        width: Math.min(width, MAX_DIMENSION),
        height: Math.min(height, MAX_DIMENSION),
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const output = await pipeline.png({ compressionLevel: 8, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true });
    return {
      body: output.data,
      width: output.info.width,
      height: output.info.height,
      sourceWidth: width,
      sourceHeight: height,
    };
  } catch (error) {
    throw new Error(`Не удалось преобразовать изображение в PNG: ${error && error.message ? error.message : error}`);
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Разрешён только GET' });
  const raw = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  if (!raw) return res.status(400).json({ ok: false, error: 'Не передан параметр url' });

  try {
    const source = await fetchImage(String(raw));
    const normalized = await normalizeToPng(source.body, source.type);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('X-Source-Type', source.type);
    res.setHeader('X-Image-Width', String(normalized.width));
    res.setHeader('X-Image-Height', String(normalized.height));
    if (normalized.sourceWidth !== normalized.width || normalized.sourceHeight !== normalized.height) {
      res.setHeader('X-Image-Resized', `${normalized.sourceWidth}x${normalized.sourceHeight}`);
    }
    return res.status(200).send(normalized.body);
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? 'Источник изображения не ответил вовремя'
      : (error && error.message ? error.message : 'Не удалось загрузить изображение');
    return res.status(502).json({ ok: false, error: message });
  }
};
