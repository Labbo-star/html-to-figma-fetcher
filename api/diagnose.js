const render = require('./render7');

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

function round(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function brief(layer) {
  return {
    kind: layer.kind,
    name: String(layer.name || '').slice(0, 120),
    text: layer.text ? String(layer.text).replace(/\s+/g, ' ').trim().slice(0, 180) : undefined,
    x: round(layer.absX ?? layer.x),
    y: round(layer.absY ?? layer.y),
    width: round(layer.width),
    height: round(layer.height),
    url: layer.url ? String(layer.url).slice(0, 260) : undefined,
    sourceUrl: layer.sourceUrl ? String(layer.sourceUrl).slice(0, 260) : undefined,
    captureId: layer.captureId || layer.backgroundCaptureId || undefined,
    preferCapture: !!layer.preferCapture,
    sectionId: layer.sectionId || undefined,
  };
}

function summarize(body) {
  const snapshot = body && body.snapshot || {};
  const layers = Array.isArray(snapshot.layers) ? snapshot.layers : [];
  const byKind = {};
  for (const layer of layers) byKind[layer && layer.kind || 'unknown'] = (byKind[layer && layer.kind || 'unknown'] || 0) + 1;

  const textLayers = layers.filter(layer => layer && layer.kind === 'text' && layer.text);
  const textCorpus = textLayers.map(layer => String(layer.text).replace(/\s+/g, ' ').trim());
  const navNameRe = /(header|menu|nav|navigation|navbar|бургер|меню)/i;
  const navTextRe = /(кейсы|услуги|о нас|блог|контакты|рассчитать проект)/i;
  const navCandidates = layers.filter(layer => navNameRe.test(String(layer && layer.name || '')) || navTextRe.test(String(layer && layer.text || ''))).slice(0, 80).map(brief);

  const svgLayers = layers.filter(layer => layer && layer.kind === 'svg');
  const unresolvedSvg = svgLayers.filter(layer => /currentColor|var\s*\(/.test(String(layer.svg || ''))).slice(0, 80).map(layer => ({
    ...brief(layer),
    currentColor: /currentColor/.test(String(layer.svg || '')),
    cssVar: /var\s*\(/.test(String(layer.svg || '')),
    sample: String(layer.svg || '').replace(/\s+/g, ' ').slice(0, 340),
  }));

  const images = layers.filter(layer => layer && layer.kind === 'image');
  const imageHosts = {};
  for (const layer of images) {
    for (const raw of [layer.url, layer.sourceUrl]) {
      if (!raw) continue;
      try {
        const host = new URL(String(raw)).hostname;
        imageHosts[host] = (imageHosts[host] || 0) + 1;
      } catch {}
    }
  }
  const imageRisk = images.filter(layer => {
    const raw = `${layer.url || ''} ${layer.sourceUrl || ''}`;
    return !layer.url || layer.preferCapture || /(?:thb|optim)\.tildacdn\.com|data:image|blob:/i.test(raw);
  }).slice(0, 120).map(brief);

  const materializedBackground = layers.find(layer => layer && layer.name === '__html2figma_page_background__');

  return {
    ok: true,
    rendererStatus: body && body.ok !== false,
    mode: body && body.mode,
    finalUrl: body && body.finalUrl,
    stats: body && body.stats || {},
    snapshot: {
      rendererVersion: snapshot.rendererVersion,
      framework: snapshot.framework,
      fidelityPass: snapshot.fidelityPass,
      width: snapshot.width,
      height: snapshot.height,
      truncated: !!snapshot.truncated,
      sections: Array.isArray(snapshot.sections) ? snapshot.sections.length : 0,
      layers: layers.length,
      byKind,
      pageBackground: snapshot.pageBackground || null,
      materializedPageBackground: materializedBackground ? brief(materializedBackground) : null,
      navTextPresence: {
        cases: textCorpus.some(t => /кейсы/i.test(t)),
        services: textCorpus.some(t => /услуги/i.test(t)),
        about: textCorpus.some(t => /о нас/i.test(t)),
        blog: textCorpus.some(t => /блог/i.test(t)),
        contacts: textCorpus.some(t => /контакты/i.test(t)),
        calculateProject: textCorpus.some(t => /рассчитать проект/i.test(t)),
      },
      navCandidates,
      svg: {
        total: svgLayers.length,
        unresolvedCount: unresolvedSvg.length,
        unresolved: unresolvedSvg,
      },
      images: {
        total: images.length,
        captureReady: images.filter(layer => !!(layer.captureId || layer.backgroundCaptureId)).length,
        preferCapture: images.filter(layer => !!layer.preferCapture).length,
        hosts: imageHosts,
        risky: imageRisk,
        samples: images.slice(0, 80).map(brief),
      },
    },
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  const raw = Array.isArray(req.query && req.query.url) ? req.query.url[0] : req.query && req.query.url;
  if (!raw) return res.status(400).json({ ok: false, error: 'url is required' });
  const widthRaw = Array.isArray(req.query && req.query.width) ? req.query.width[0] : req.query && req.query.width;
  const width = Math.max(320, Math.min(1920, Number(widthRaw) || 1440));
  try {
    const result = await runRenderer({ method: 'GET', query: { url: String(raw), width: String(width) }, headers: req.headers || {} });
    if (result.statusCode !== 200 || result.kind !== 'json' || !result.body || !result.body.snapshot) {
      return res.status(result.statusCode || 500).json({ ok: false, rendererStatus: result.statusCode, body: result.body || null });
    }
    return res.status(200).json(summarize(result.body));
  } catch (error) {
    return res.status(500).json({ ok: false, error: error && error.message ? error.message : String(error) });
  }
};
