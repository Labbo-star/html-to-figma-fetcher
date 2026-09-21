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
  if (!snapshot || !Array.isArray(snapshot.layers)) return 0;
  let exact = 0;
  for (const layer of snapshot.layers) {
    const p = Number(layer && layer.paintOrder);
    if (!Number.isFinite(p)) continue;
    // Existing plugin versions already sort siblings by stackPath. Feeding the
    // exact Chromium paint order through that contract fixes cross-layer overlap
    // without changing the user's saved plugin settings or existing frames.
    layer.stackPath = [p];
    layer.zIndex = 0;
    exact++;
  }
  snapshot.paintOrderLayers = exact;
  return exact;
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
    const snapshot = result.body.snapshot;
    const enriched = Number(snapshot.rendererVersion) >= 18 && snapshot.enrichment && snapshot.enrichment.paintOrder === true;
    if (!enriched) {
      return res.status(503).json({
        ok: false,
        error: 'Точный проход Chromium v19 не завершился. Импорт остановлен, чтобы не создавать заведомо неточный макет. Повторите импорт.',
      });
    }
    const exact = promotePaintOrder(snapshot);
    if (exact <= 0) {
      return res.status(503).json({
        ok: false,
        error: 'Chromium не вернул paint order слоёв. Импорт остановлен, чтобы не нарушить порядок перекрытия элементов.',
      });
    }
    snapshot.rendererVersion = 19;
    const stats = Object.assign({}, result.body.stats || {}, { paintOrderLayers: exact });
    return res.status(200).json(Object.assign({}, result.body, {
      mode: 'browser-snapshot-v19',
      snapshot,
      stats,
    }));
  }
  return forward(result, res);
};
