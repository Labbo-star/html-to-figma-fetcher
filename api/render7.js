const render6 = require('./render6');
const render5 = require('./render5');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}
function normalizeTildaUrl(raw) {
  if (!raw) return raw;
  try {
    const u = new URL(String(raw));
    if (/^(thb|optim)\.tildacdn\.com$/i.test(u.hostname)) {
      u.hostname = 'static.tildacdn.com';
      u.pathname = u.pathname
        .replace(/\/-\/(?:resize|format|quality|scale_crop|cover)\/[^/]+/gi, '')
        .replace(/\/+/g, '/');
      return u.href;
    }
  } catch {}
  return raw;
}
function postProcess(data) {
  if (!data || !data.snapshot || !Array.isArray(data.snapshot.layers)) return data;
  data.snapshot.layers = data.snapshot.layers.map(layer => {
    if (!layer || layer.kind !== 'image') return layer;
    return {
      ...layer,
      url: normalizeTildaUrl(layer.url),
      sourceUrl: normalizeTildaUrl(layer.sourceUrl || layer.url),
    };
  });
  data.snapshot.rendererVersion = 8;
  data.mode = 'browser-snapshot-v8-stable';
  data.stats = {
    ...(data.stats || {}),
    imageLayers: data.snapshot.layers.filter(x => x && x.kind === 'image').length,
    textLayers: data.snapshot.layers.filter(x => x && x.kind === 'text').length,
  };
  return data;
}
function makeCaptureRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return value; },
    send(value) { this.body = value; return value; },
    end(value) { this.body = value; return value; },
  };
}
async function run(handler, req) {
  const captured = makeCaptureRes();
  await handler(req, captured);
  return captured;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Разрешены только GET и OPTIONS' });
  if (String(req.query.ping || '') === '1') return res.status(200).json({ ok: true, service: 'browser-renderer-stable', version: 8 });

  const swallowed = [];
  const onUnhandled = reason => swallowed.push(reason && reason.message ? reason.message : String(reason));
  process.on('unhandledRejection', onUnhandled);
  try {
    let first;
    try { first = await run(render6, req); }
    catch (e) { first = { statusCode: 500, body: { ok: false, error: e && e.message ? e.message : String(e) } }; }
    if (first.statusCode >= 200 && first.statusCode < 300 && first.body && first.body.ok !== false) {
      const data = postProcess(first.body);
      if (swallowed.length) data.runtimeWarnings = swallowed.slice(0, 5);
      return res.status(200).json(data);
    }

    let second;
    try { second = await run(render5, req); }
    catch (e) { second = { statusCode: 500, body: { ok: false, error: e && e.message ? e.message : String(e) } }; }
    if (second.statusCode >= 200 && second.statusCode < 300 && second.body && second.body.ok !== false) {
      const data = postProcess(second.body);
      data.fallbackRenderer = 'render5';
      if (swallowed.length) data.runtimeWarnings = swallowed.slice(0, 5);
      return res.status(200).json(data);
    }

    const e1 = first && first.body && (first.body.error || first.body.message) ? String(first.body.error || first.body.message) : `HTTP ${first && first.statusCode || 500}`;
    const e2 = second && second.body && (second.body.error || second.body.message) ? String(second.body.error || second.body.message) : `HTTP ${second && second.statusCode || 500}`;
    return res.status(502).json({ ok: false, error: `render6: ${e1} | render5: ${e2}`, runtimeWarnings: swallowed.slice(0, 5) });
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
};
