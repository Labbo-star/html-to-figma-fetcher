const render = require('./render25');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function runRenderer(req) {
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
    Promise.resolve(render(req, res)).then(() => {
      if (!finished) done('end');
    }).catch(reject);
  });
}

function byteLengthFromBase64(raw) {
  const s = String(raw || '');
  if (!s) return 0;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(s.length * 3 / 4) - pad);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  const raw = Array.isArray(req.query && req.query.url) ? req.query.url[0] : req.query && req.query.url;
  if (!raw) return res.status(400).json({ ok: false, error: 'url is required' });
  const widthRaw = Array.isArray(req.query && req.query.width) ? req.query.width[0] : req.query && req.query.width;
  const width = Math.max(320, Math.min(1920, Number(widthRaw) || 1440));
  const limitRaw = Array.isArray(req.query && req.query.limit) ? req.query.limit[0] : req.query && req.query.limit;
  const limit = Math.max(1, Math.min(6, Number(limitRaw) || 3));

  try {
    const snapResult = await runRenderer({
      method: 'GET',
      query: { url: String(raw), width: String(width) },
      headers: req.headers || {},
    });
    if (snapResult.statusCode !== 200 || snapResult.kind !== 'json' || !snapResult.body || !snapResult.body.snapshot) {
      return res.status(snapResult.statusCode || 500).json({ ok: false, stage: 'snapshot', body: snapResult.body || null });
    }

    const layers = Array.isArray(snapResult.body.snapshot.layers) ? snapResult.body.snapshot.layers : [];
    const candidates = layers.filter(layer => layer && layer.kind === 'image' && layer.captureId).slice(0, limit);
    if (!candidates.length) {
      return res.status(200).json({ ok: true, url: String(raw), width, candidates: 0, requested: 0, successful: 0, captures: [] });
    }

    const clips = candidates.map((layer, index) => ({
      id: `diag-${index}`,
      captureId: String(layer.captureId),
      captureMode: layer.captureMode === 'background' ? 'background' : 'element',
    }));

    const captureResult = await runRenderer({
      method: 'POST',
      query: {},
      headers: { ...(req.headers || {}), 'content-type': 'application/json' },
      body: { mode: 'capture-clips', url: String(raw), width, clips },
    });

    if (captureResult.statusCode !== 200 || captureResult.kind !== 'json' || !captureResult.body) {
      return res.status(captureResult.statusCode || 500).json({ ok: false, stage: 'capture', body: captureResult.body || null });
    }

    const returned = Array.isArray(captureResult.body.captures) ? captureResult.body.captures : [];
    const captures = clips.map((clip, index) => {
      const got = returned.find(item => String(item && item.id) === clip.id) || null;
      const source = candidates[index];
      return {
        id: clip.id,
        captureId: clip.captureId,
        captureMode: clip.captureMode,
        sourceName: String(source && source.name || '').slice(0, 120),
        sourceUrl: source && (source.sourceUrl || source.url) ? String(source.sourceUrl || source.url).slice(0, 260) : null,
        preferCapture: !!(source && source.preferCapture),
        ok: !!(got && got.dataBase64),
        pngBytes: got && got.dataBase64 ? byteLengthFromBase64(got.dataBase64) : 0,
        error: got && got.error ? String(got.error).slice(0, 220) : null,
      };
    });

    return res.status(200).json({
      ok: true,
      url: String(raw),
      width,
      rendererVersion: snapResult.body.snapshot.rendererVersion,
      framework: snapResult.body.snapshot.framework,
      imageLayers: layers.filter(layer => layer && layer.kind === 'image').length,
      captureReadyLayers: layers.filter(layer => layer && layer.kind === 'image' && layer.captureId).length,
      requested: clips.length,
      successful: captures.filter(item => item.ok).length,
      captures,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error && error.message ? error.message : String(error) });
  }
};
