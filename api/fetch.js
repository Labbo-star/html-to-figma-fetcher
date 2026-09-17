from pathlib import Path
code = r"""const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15000;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase().split('%')[0];
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(value)) return true;

  if (value.startsWith('::ffff:')) {
    const v4 = value.slice(7);
    if (net.isIP(v4) === 4) return isPrivateIPv4(v4);
  }
  return false;
}

function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true;
}

async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Некорректный URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Разрешены только http/https ссылки');
  }

  if (url.username || url.password) {
    throw new Error('URL с логином/паролем не поддерживаются');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Локальные адреса запрещены');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Приватные IP-адреса запрещены');
    return url;
  }

  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch(() => []),
    dns.resolve6(hostname).catch(() => []),
  ]);

  const addresses = [...v4, ...v6];

  if (!addresses.length) throw new Error('Домен не найден');
  if (addresses.some(isPrivateIp)) throw new Error('Сайт ведёт на приватный IP-адрес');

  return url;
}

async function readBodyLimited(response) {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;

    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new Error('HTML страницы превышает лимит 3 МБ');
    }

    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder('utf-8').decode(merged);
}

async function fetchHtml(startUrl) {
  let current = await assertPublicUrl(startUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response;

    try {
      response = await fetch(current.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HTML-to-Figma-Fetcher/1.0)',
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'Accept-Language': 'ru,en;q=0.8',
        },
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('Сайт не ответил за 15 секунд');
      }
      throw new Error('Не удалось загрузить страницу');
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');

      if (!location) {
        throw new Error('Сайт вернул редирект без адреса');
      }

      if (redirectCount === MAX_REDIRECTS) {
        throw new Error('Слишком много перенаправлений');
      }

      current = await assertPublicUrl(new URL(location, current).href);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Сайт вернул HTTP ${response.status}`);
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    if (
      contentType &&
      !contentType.includes('text/html') &&
      !contentType.includes('application/xhtml+xml')
    ) {
      throw new Error(`Ожидался HTML, получено: ${contentType.split(';')[0]}`);
    }

    const declaredLength = Number(response.headers.get('content-length') || 0);

    if (declaredLength > MAX_BYTES) {
      throw new Error('HTML страницы превышает лимит 3 МБ');
    }

    const html = await readBodyLimited(response);

    if (!html.trim()) {
      throw new Error('Сайт вернул пустую страницу');
    }

    return {
      html,
      finalUrl: current.href,
      contentType: contentType || 'text/html',
    };
  }

  throw new Error('Слишком много перенаправлений');
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({
      ok: false,
      error: 'Разрешены только GET и OPTIONS',
    });
    return;
  }

  const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;

  if (!rawUrl) {
    res.status(400).json({
      ok: false,
      error: 'Не передан параметр url',
    });
    return;
  }

  try {
    const result = await fetchHtml(String(rawUrl));

    res.status(200).json({
      ok: true,
      ...result,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Не удалось загрузить страницу';

    res.status(502).json({
      ok: false,
      error: message,
    });
  }
};
"""
path = Path('/mnt/data/fetch.js')
path.write_text(code, encoding='utf-8')
print(path)
