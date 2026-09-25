const render = require('./render7');

function mockRun(handler, req) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    let finished = false;
    const headers = {};
    const done = (kind, body) => {
      if (finished) return;
      finished = true;
      resolve({ statusCode, headers, kind, body });
    };
    const res = {
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
      status(code) { statusCode = Number(code) || 200; return this; },
      json(body) { done('json', body); return this; },
      send(body) { done('send', body); return this; },
      end(body) { done('end', body); return this; },
    };
    Promise.resolve(handler(req, res))
      .then(() => { if (!finished) done('end'); })
      .catch(reject);
  });
}

function forward(result, res) {
  for (const [k, v] of Object.entries(result.headers || {})) {
    try { res.setHeader(k, v); } catch {}
  }
  const out = res.status(result.statusCode || 200);
  if (result.kind === 'json') return out.json(result.body);
  if (result.kind === 'send') return out.send(result.body);
  return out.end(result.body);
}

function removeOffscreenRecoveredFixed(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.layers)) return 0;
  const width = Math.max(1, Number(snapshot.width) || 1440);
  const viewportHeight = 1100;
  let removed = 0;
  snapshot.layers = snapshot.layers.filter(layer => {
    if (!layer || !/— fixed(?:\s|$)/i.test(String(layer.name || ''))) return true;
    const x = Number(layer.absX ?? layer.x) || 0;
    const y = Number(layer.absY ?? layer.y) || 0;
    const w = Math.max(0, Number(layer.width) || 0);
    const h = Math.max(0, Number(layer.height) || 0);
    const outside = x + w <= 0 || x >= width || y + h <= 0 || y >= viewportHeight;
    if (outside) removed++;
    return !outside;
  });
  return removed;
}

function preserveEditableVectorImages(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.layers)) return 0;
  let changed = 0;
  for (const layer of snapshot.layers) {
    if (!layer || layer.kind !== 'image' || layer.preferCapture !== true) continue;
    if (layer.captureMode === 'background') continue;
    const url = String(layer.sourceUrl || layer.url || '');
    if (!/\.svg(?:[?#]|$)/i.test(url)) continue;
    layer.preferCapture = false;
    changed++;
  }
  return changed;
}

function activePreferredCaptures(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.layers)) return 0;
  return snapshot.layers.filter(layer => layer && layer.kind === 'image' && layer.preferCapture === true).length;
}

module.exports = async function handler(req, res) {
  try {
    const result = await mockRun(render, req);
    if (result.kind === 'json' && result.body && result.body.snapshot && Array.isArray(result.body.snapshot.layers)) {
      const snapshot = result.body.snapshot;
      const offscreenFixedRemoved = removeOffscreenRecoveredFixed(snapshot);
      const vectorCapturesPreserved = preserveEditableVectorImages(snapshot);
      result.body.stats = {
        ...(result.body.stats || {}),
        offscreenFixedRemoved: Number(result.body.stats && result.body.stats.offscreenFixedRemoved || 0) + offscreenFixedRemoved,
        vectorCapturesPreserved: Number(result.body.stats && result.body.stats.vectorCapturesPreserved || 0) + vectorCapturesPreserved,
        preferredImageCapturesActive: activePreferredCaptures(snapshot),
        layers: snapshot.layers.length,
      };
    }
    return forward(result, res);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error && error.message ? error.message : String(error) });
  }
};

module.exports._test = { removeOffscreenRecoveredFixed, preserveEditableVectorImages, activePreferredCaptures };
