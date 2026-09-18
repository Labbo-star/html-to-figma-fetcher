function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}

function proxyImage(url, origin, referer) {
  const raw = String(url || '');
  if (!raw || /^data:/i.test(raw) || /^blob:/i.test(raw)) return raw;
  if (raw.startsWith(`${origin}/api/image2?url=`)) return raw;
  const ref = referer ? `&ref=${encodeURIComponent(referer)}` : '';
  return `${origin}/api/image2?url=${encodeURIComponent(raw)}${ref}`;
}

function proxySnapshot(snapshot, origin, referer) {
  return {
    ...snapshot,
    sections: Array.isArray(snapshot.sections) ? snapshot.sections : [],
    layers: Array.isArray(snapshot.layers)
      ? snapshot.layers.map((layer) => {
          if (!layer || layer.kind !== 'image' || !layer.url || layer.imageDataBase64) return layer;
          return {
            ...layer,
            sourceUrl: layer.sourceUrl || layer.url,
            url: proxyImage(layer.url, origin, referer),
          };
        })
      : [],
  };
}

async function callRenderer(origin, path, rawUrl, width, signal) {
  const endpoint = `${origin}${path}?url=${encodeURIComponent(String(rawUrl))}&width=${encodeURIComponent(String(width))}`;
  const response = await fetch(endpoint, { method: 'GET', cache: 'no-store', signal });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!response.ok || !data || data.ok === false) {
    const message = data && (data.error || data.message) ? String(data.error || data.message) : `HTTP ${response.status}`;
    throw new Error(`${path}: ${message}`);
  }
  if (!data.snapshot || !Array.isArray(data.snapshot.layers)) throw new Error(`${path}: сервер не вернул снимок страницы`);
  return data;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Разрешены только GET и OPTIONS' });
  if (String(req.query.ping || '') === '1') return res.status(200).json({ ok: true, service: 'compat-fetcher', version: 8 });

  const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  const rawWidth = Array.isArray(req.query.width) ? req.query.width[0] : req.query.width;
  const width = Math.max(320, Math.min(1920, Number(rawWidth) || 1440));
  if (!rawUrl) return res.status(400).json({ ok: false, error: 'Не передан параметр url' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 58000);
  try {
    const origin = `https://${req.headers.host || 'html-to-figma-fetcher-v2.vercel.app'}`;
    let data;
    let primaryError = '';
    try {
      data = await callRenderer(origin, '/api/render7', rawUrl, width, controller.signal);
    } catch (error) {
      primaryError = error && error.message ? error.message : String(error);
      data = await callRenderer(origin, '/api/render5', rawUrl, width, controller.signal);
      data.fallbackRenderer = 'render5';
      data.primaryRendererError = primaryError;
    }

    const referer = data.finalUrl || String(rawUrl);
    const snapshot = proxySnapshot(data.snapshot, origin, referer);
    return res.status(200).json({
      ok: true,
      mode: data.mode || 'browser-snapshot-v8-stable',
      finalUrl: referer,
      snapshot,
      fallbackRenderer: data.fallbackRenderer || null,
      primaryRendererError: data.primaryRendererError || null,
      stats: data.stats || {
        layers: snapshot.layers.length,
        sections: snapshot.sections.length,
        height: snapshot.height,
        truncated: !!snapshot.truncated,
      },
    });
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? 'Серверный Chromium не успел завершить рендер за 58 секунд'
      : (error && error.message ? error.message : 'Не удалось вызвать серверный Chromium');
    return res.status(502).json({ ok: false, error: message });
  } finally {
    clearTimeout(timer);
  }
};
