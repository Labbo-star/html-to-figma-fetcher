const renderCore = require('./render23');

// v22-compatible post-processing shim.
// Keeps rendererVersion=22 for the current Figma plugin while fixing two
// browser-vs-Figma paint-order artifacts found in real Tilda imports:
// 1) transient Tilda notification overlays (t657),
// 2) hero slider images that should sit behind overlapping card backgrounds.

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

function overlapArea(a, b) {
  const ax = Number(a.absX ?? a.x) || 0;
  const ay = Number(a.absY ?? a.y) || 0;
  const bx = Number(b.absX ?? b.x) || 0;
  const by = Number(b.absY ?? b.y) || 0;
  const ix = Math.max(0, Math.min(ax + Number(a.width || 0), bx + Number(b.width || 0)) - Math.max(ax, bx));
  const iy = Math.max(0, Math.min(ay + Number(a.height || 0), by + Number(b.height || 0)) - Math.max(ay, by));
  return ix * iy;
}

function removeTransientTildaNotifications(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.layers)) return 0;
  const blocked = new Set();
  const transientRe = /(?:^|\.)t657__(?:wrapper|close-button|icon-close)(?:\.|\s|$)/i;

  for (const layer of snapshot.layers) {
    if (!layer || layer.kind !== 'container' || !layer.containerKey) continue;
    if (transientRe.test(String(layer.name || ''))) blocked.add(layer.containerKey);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const layer of snapshot.layers) {
      if (!layer || !layer.containerKey || !layer.parentContainerKey) continue;
      if (blocked.has(layer.parentContainerKey) && !blocked.has(layer.containerKey)) {
        blocked.add(layer.containerKey);
        changed = true;
      }
    }
  }

  let removed = 0;
  snapshot.layers = snapshot.layers.filter(layer => {
    if (!layer) return false;
    const drop = transientRe.test(String(layer.name || '')) ||
      (!!layer.containerKey && blocked.has(layer.containerKey)) ||
      (!!layer.parentContainerKey && blocked.has(layer.parentContainerKey));
    if (drop) removed++;
    return !drop;
  });
  return removed;
}

function raiseCardBackgroundsAboveHeroMedia(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.layers)) return 0;
  const layers = snapshot.layers;
  const cards = layers.filter(layer => {
    if (!layer || layer.kind !== 'shape') return false;
    if (!layer.fill || layer.fill.kind !== 'solid' || !layer.fill.color || Number(layer.fill.color.a) < 0.55) return false;
    const y = Number(layer.absY ?? layer.y) || 0;
    const w = Number(layer.width) || 0;
    const h = Number(layer.height) || 0;
    const radius = Number(layer.radius) || 0;
    return y < 1250 && w >= 90 && w <= 760 && h >= 45 && h <= 560 && radius >= 6;
  });

  const touched = new Set();
  for (const image of layers) {
    if (!image || image.kind !== 'image') continue;
    if (image.textRaster) continue;
    const y = Number(image.absY ?? image.y) || 0;
    const w = Number(image.width) || 0;
    const h = Number(image.height) || 0;
    if (y >= 1250 || w < 240 || h < 240) continue;
    if (/section background/i.test(String(image.name || ''))) continue;

    const hits = [];
    for (const card of cards) {
      if (image.sectionId && card.sectionId && image.sectionId !== card.sectionId) continue;
      const cardArea = Math.max(1, Number(card.width || 0) * Number(card.height || 0));
      if (overlapArea(image, card) / cardArea >= 0.08) hits.push(card);
    }
    if (hits.length < 2) continue;

    // Figma sorts siblings by stackPath -> zIndex -> paintPhase -> z.
    // Browser background media is represented by a container (paintPhase 1),
    // while CSS card backgrounds arrive as shapes (paintPhase 0). Raising only
    // those overlapping card backgrounds to phase 1 preserves their text/buttons
    // (phase 2) and reproduces the browser's intended layering.
    for (const card of hits) {
      if ((Number(card.paintPhase) || 0) < 1) {
        card.paintPhase = 1;
        touched.add(card);
      }
    }
  }
  return touched.size;
}

module.exports = async function handler(req, res) {
  try {
    const result = await mockRun(renderCore, req);
    if (result.kind === 'json' && result.body && result.body.snapshot && Array.isArray(result.body.snapshot.layers)) {
      const snapshot = result.body.snapshot;
      const removed = removeTransientTildaNotifications(snapshot);
      const stacking = raiseCardBackgroundsAboveHeroMedia(snapshot);
      result.body.stats = {
        ...(result.body.stats || {}),
        popupLayersRemoved: Number(result.body.stats && result.body.stats.popupLayersRemoved || 0) + removed,
        stackingAdjusted: Number(result.body.stats && result.body.stats.stackingAdjusted || 0) + stacking,
      };
    }
    return forward(result, res);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error && error.message ? error.message : String(error) });
  }
};
