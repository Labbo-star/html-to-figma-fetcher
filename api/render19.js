const render18 = require('./render18');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}

function runCaptured(handler, req) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    let finished = false;
    const headers = {};
    const finish = (kind, body) => {
      if (finished) return;
      finished = true;
      resolve({ statusCode, headers, kind, body });
    };
    const res = {
      setHeader(key, value) { headers[String(key).toLowerCase()] = value; return this; },
      status(code) { statusCode = Number(code) || 200; return this; },
      json(body) { finish('json', body); return this; },
      send(body) { finish('send', body); return this; },
      end(body) { finish('end', body); return this; },
    };
    Promise.resolve(handler(req, res)).then(() => { if (!finished) finish('end', undefined); }).catch(reject);
  });
}

function forward(result, res) {
  for (const [key, value] of Object.entries(result.headers || {})) {
    try { res.setHeader(key, value); } catch {}
  }
  const out = res.status(result.statusCode || 200);
  if (result.kind === 'json') return out.json(result.body);
  if (result.kind === 'send') return out.send(result.body);
  return out.end(result.body);
}

function promotePaintOrder(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.layers)) return snapshot;
  let exact = 0;
  for (const layer of snapshot.layers) {
    const p = Number(layer && layer.paintOrder);
    if (!Number.isFinite(p)) continue;
    // The published Figma importer already sorts by stackPath. Reuse that stable
    // contract so exact Chromium paint order works without changing old projects.
    layer.stackPath = [p];
    layer.zIndex = 0;
    exact++;
  }
  snapshot.rendererVersion = 19;
  snapshot.paintOrderLayers = exact;
  return snapshot;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET' && String(req.query && req.query.ping || '') === '1') {
    return res.status(200).json({
      ok: true,
      service: 'browser-renderer',
      version: 19,
      exactPaintOrder: true,
      logicalText: true,
      elementorReveal: true,
      visualQa: true,
    });
  }

  const result = await runCaptured(render18, req);
  if (result.statusCode === 200 && result.kind === 'json' && result.body && result.body.snapshot) {
    const snapshot = promotePaintOrder(result.body.snapshot);
    const stats = Object.assign({}, result.body.stats || {}, {
      paintOrderLayers: snapshot.paintOrderLayers || 0,
    });
    return res.status(200).json(Object.assign({}, result.body, {
      mode: 'browser-snapshot-v19',
      snapshot,
      stats,
    }));
  }
  return forward(result, res);
};
