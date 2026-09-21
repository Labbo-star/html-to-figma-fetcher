const renderCore = require('./render22');

// v22-compatible fidelity shim.
// Keeps the public renderer version at 22 so the existing Figma plugin does not
// need a coordinated release, but gives Figma a little more text-box tolerance.
// The browser snapshot already contains explicit \n line breaks from DOM Ranges;
// this layer prevents Figma's slightly different font metrics from re-wrapping
// or shrinking those lines.

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

function round2(v) { return Math.round(v * 100) / 100; }

function stabilizeFigmaText(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.layers)) return 0;
  let adjusted = 0;

  for (const layer of snapshot.layers) {
    if (!layer || layer.kind !== 'text' || !layer.text) continue;

    const text = String(layer.text);
    const explicitLines = text.split('\n').length;
    const expectedLines = Math.max(1, Number(layer.expectedLineCount) || 1, explicitLines);
    const fs = Math.max(4, Number(layer.fontSize) || 16);
    const lh = Math.max(fs, Number(layer.lineHeight) || fs * 1.2);

    // Figma's text bounds are usually a few pixels taller than Chromium's.
    // Increase only the invisible text box, never font size/line-height.
    const verticalSlack = Math.max(6, fs * 0.45 + Math.max(0, expectedLines - 1) * 1.25);
    const minHeight = lh * expectedLines + verticalSlack;
    if ((Number(layer.height) || 0) < minHeight) {
      layer.height = round2(minHeight);
      adjusted++;
    }

    // Chromium already supplied hard line breaks. Give each line a small amount
    // of horizontal breathing room so a fallback font in Figma does not wrap a
    // browser line a second time. Keep the visual alignment anchor unchanged.
    if (expectedLines > 1 && explicitLines > 1) {
      const oldWidth = Math.max(1, Number(layer.width) || 1);
      const extra = Math.min(24, Math.max(5, oldWidth * 0.04));
      const align = String(layer.textAlign || 'LEFT').toUpperCase();
      const shift = align === 'RIGHT' ? extra : align === 'CENTER' ? extra / 2 : 0;
      if (shift) {
        if (Number.isFinite(Number(layer.x))) layer.x = round2(Number(layer.x) - shift);
        if (Number.isFinite(Number(layer.absX))) layer.absX = round2(Number(layer.absX) - shift);
      }
      layer.width = round2(oldWidth + extra);
      adjusted++;
    }

    layer.expectedLineCount = expectedLines;
  }

  return adjusted;
}

module.exports = async function handler(req, res) {
  try {
    const result = await mockRun(renderCore, req);
    if (result.kind === 'json' && result.body && result.body.snapshot && Array.isArray(result.body.snapshot.layers)) {
      const count = stabilizeFigmaText(result.body.snapshot);
      result.body.stats = { ...(result.body.stats || {}), figmaTextBoxesStabilized: count };
    }
    return forward(result, res);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error && error.message ? error.message : String(error) });
  }
};
