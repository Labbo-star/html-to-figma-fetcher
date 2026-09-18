function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}

function escText(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(value) { return escText(value).replace(/"/g, '&quot;'); }
function channel(v) { return Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255))); }
function alpha(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
function cssColor(c) {
  if (!c) return 'rgba(0,0,0,0)';
  return `rgba(${channel(c.r)},${channel(c.g)},${channel(c.b)},${alpha(c.a)})`;
}
function fillCss(fill) {
  if (!fill) return 'transparent';
  if (fill.kind === 'solid') return cssColor(fill.color);
  if (fill.kind === 'linear' && Array.isArray(fill.stops) && fill.stops.length) {
    const stops = fill.stops.map((s) => `${cssColor(s.color)} ${Math.round((Number(s.position) || 0) * 100)}%`).join(',');
    return `linear-gradient(${Number(fill.angle) || 180}deg,${stops})`;
  }
  return 'transparent';
}
function proxyImage(url, origin) {
  const raw = String(url || '');
  if (!raw || /^data:/i.test(raw) || /^blob:/i.test(raw)) return raw;
  return `${origin}/api/image?url=${encodeURIComponent(raw)}`;
}

function snapshotToHtml(snapshot, origin) {
  const width = Number(snapshot.width) || 1440;
  const sections = Array.isArray(snapshot.sections) && snapshot.sections.length
    ? snapshot.sections.slice().sort((a, b) => (Number(a.y) || 0) - (Number(b.y) || 0))
    : [{ id: 'section-0', name: 'page', y: 0, height: Number(snapshot.height) || 1 }];

  const byId = new Map(sections.map((s) => [s.id, []]));
  for (const layer of snapshot.layers || []) {
    let id = layer.sectionId;
    if (!byId.has(id)) {
      const y = Number(layer.y) || 0;
      const match = sections.find((s) => y >= Number(s.y || 0) - 2 && y <= Number(s.y || 0) + Number(s.height || 0) + 2);
      id = match ? match.id : sections[0].id;
    }
    byId.get(id).push(layer);
  }

  const sectionHtml = sections.map((section) => {
    const items = (byId.get(section.id) || [])
      .sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0))
      .map((layer) => {
        const localY = (Number(layer.y) || 0) - (Number(section.y) || 0);
        const style = [
          'position:absolute',
          `left:${Number(layer.x) || 0}px`,
          `top:${localY}px`,
          `width:${Math.max(1, Number(layer.width) || 1)}px`,
          `height:${Math.max(1, Number(layer.height) || 1)}px`,
          `opacity:${Math.max(0.01, Math.min(1, Number(layer.opacity) || 1))}`,
          `z-index:${Number(layer.z) || 0}`,
          'box-sizing:border-box',
          'margin:0',
        ];
        if (layer.radius) style.push(`border-radius:${Number(layer.radius) || 0}px`);
        if (layer.shadow) style.push(`box-shadow:${Number(layer.shadow.x) || 0}px ${Number(layer.shadow.y) || 0}px ${Number(layer.shadow.blur) || 0}px ${Number(layer.shadow.spread) || 0}px ${cssColor(layer.shadow.color)}`);

        if (layer.kind === 'image' && layer.url) {
          style.push(`object-fit:${layer.imageScaleMode === 'FIT' ? 'contain' : 'cover'}`, 'display:block');
          return `<img data-browser-snapshot="image" src="${escAttr(proxyImage(layer.url, origin))}" style="${style.join(';')}">`;
        }
        if (layer.kind === 'svg' && layer.svg) {
          const svg = String(layer.svg)
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<svg\b/i, '<svg style="width:100%;height:100%;display:block"');
          return `<div data-browser-snapshot="svg" style="${style.join(';')}">${svg}</div>`;
        }
        if (layer.kind === 'text') {
          const c = layer.fill && layer.fill.kind === 'solid' ? cssColor(layer.fill.color) : 'rgba(0,0,0,1)';
          style.push(
            `color:${c}`,
            `font-family:${escAttr(layer.fontFamily || 'Inter')}`,
            `font-size:${Number(layer.fontSize) || 16}px`,
            `font-weight:${Number(layer.fontWeight) || 400}`,
            `line-height:${Number(layer.lineHeight) || (Number(layer.fontSize) || 16) * 1.2}px`,
            `letter-spacing:${Number(layer.letterSpacing) || 0}px`,
            `text-align:${String(layer.textAlign || 'LEFT').toLowerCase()}`,
            'white-space:pre-wrap',
            'overflow:hidden',
            'padding:0'
          );
          return `<div data-browser-snapshot="text" style="${style.join(';')}">${escText(layer.text || '')}</div>`;
        }
        if (layer.fill) style.push(`background:${fillCss(layer.fill)}`);
        if (layer.stroke && layer.strokeWeight) style.push(`border:${Number(layer.strokeWeight) || 1}px solid ${cssColor(layer.stroke)}`);
        return `<div data-browser-snapshot="shape" style="${style.join(';')}"></div>`;
      }).join('');

    return `<section class="t-rec" data-source-section="${escAttr(section.name || section.id)}" style="position:relative;width:${width}px;height:${Math.max(1, Number(section.height) || 1)}px;overflow:hidden;margin:0;padding:0">${items}</section>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0!important;padding:0!important;width:${width}px!important;min-width:${width}px!important;background:#fff}main{margin:0;padding:0;width:100%}section{display:block}</style></head><body><main id="allrecords">${sectionHtml}</main></body></html>`;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Разрешены только GET и OPTIONS' });

  const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  const rawWidth = Array.isArray(req.query.width) ? req.query.width[0] : req.query.width;
  const width = Math.max(320, Math.min(1920, Number(rawWidth) || 1440));
  if (!rawUrl) return res.status(400).json({ ok: false, error: 'Не передан параметр url' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 27500);
  try {
    const origin = `https://${req.headers.host || 'html-to-figma-fetcher-v2.vercel.app'}`;
    const endpoint = `${origin}/api/render?url=${encodeURIComponent(String(rawUrl))}&width=${encodeURIComponent(String(width))}`;
    const response = await fetch(endpoint, { method: 'GET', cache: 'no-store', signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (!response.ok || !data || data.ok === false) {
      const message = data && (data.error || data.message) ? String(data.error || data.message) : `HTTP ${response.status}`;
      return res.status(502).json({ ok: false, error: `Серверный Chromium: ${message}` });
    }
    if (!data.snapshot || !Array.isArray(data.snapshot.layers)) {
      return res.status(502).json({ ok: false, error: 'Серверный Chromium не вернул снимок страницы' });
    }

    const html = snapshotToHtml(data.snapshot, origin);
    if (html.length > 2950000) {
      return res.status(502).json({ ok: false, error: 'Отрендерированный снимок страницы превышает лимит 2.95 МБ' });
    }

    return res.status(200).json({
      ok: true,
      mode: data.mode || 'browser-snapshot-v3',
      finalUrl: data.finalUrl || String(rawUrl),
      html,
      stats: data.stats || {
        layers: data.snapshot.layers.length,
        sections: Array.isArray(data.snapshot.sections) ? data.snapshot.sections.length : 0,
        height: data.snapshot.height,
        truncated: !!data.snapshot.truncated,
      },
    });
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? 'Серверный Chromium не успел завершить рендер за 27.5 секунды'
      : (error && error.message ? error.message : 'Не удалось вызвать серверный Chromium');
    return res.status(502).json({ ok: false, error: message });
  } finally {
    clearTimeout(timer);
  }
};