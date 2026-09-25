const renderCore = require('./render23');
const { materializePageBackground } = require('./page-background');

// v22-compatible fidelity layer. Keep the public contract stable for the current
// Figma plugin while fixing browser -> snapshot losses in one place.

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

    for (const card of hits) {
      if ((Number(card.paintPhase) || 0) < 1) {
        card.paintPhase = 1;
        touched.add(card);
      }
    }
  }
  return touched.size;
}

function sectionForY(snapshot, y) {
  const sections = Array.isArray(snapshot && snapshot.sections) ? snapshot.sections : [];
  const hit = sections.find(s => y >= Number(s.y || 0) - 2 && y <= Number(s.y || 0) + Number(s.height || 0) + 2);
  return hit ? hit.id : (sections[0] ? sections[0].id : undefined);
}

function normText(v) {
  return String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function near(a, b, tolerance = 8) {
  const ax = Number(a.absX ?? a.x) || 0, ay = Number(a.absY ?? a.y) || 0;
  const bx = Number(b.absX ?? b.x) || 0, by = Number(b.absY ?? b.y) || 0;
  return Math.abs(ax - bx) <= tolerance && Math.abs(ay - by) <= tolerance &&
    Math.abs(Number(a.width || 0) - Number(b.width || 0)) <= Math.max(12, tolerance * 2) &&
    Math.abs(Number(a.height || 0) - Number(b.height || 0)) <= Math.max(12, tolerance * 2);
}

function isDuplicate(snapshot, candidate) {
  for (const layer of snapshot.layers || []) {
    if (!layer || layer.kind !== candidate.kind || !near(layer, candidate)) continue;
    if (candidate.kind === 'text' && normText(layer.text) !== normText(candidate.text)) continue;
    return true;
  }
  return false;
}

function markReliableImageCaptures(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.layers)) return 0;
  const framework = String(snapshot.framework || '').toLowerCase();
  let count = 0;
  for (const layer of snapshot.layers) {
    if (!layer || layer.kind !== 'image' || layer.captureSafe === false || !layer.captureId) continue;
    const url = String(layer.sourceUrl || layer.url || '');
    const tildaAsset = /(?:^|\.)tildacdn\.com|tilda\.ws|\/tild/i.test(url);
    const riskyBackground = layer.captureMode === 'background' && (
      !/^(?:50%|center)\s+(?:50%|center)$/i.test(String(layer.backgroundPosition || '50% 50%').trim()) ||
      !/^(?:cover|contain)$/i.test(String(layer.backgroundSize || 'cover').trim())
    );
    const shouldCapture = framework === 'tilda' || tildaAsset || !url || riskyBackground;
    if (shouldCapture && layer.preferCapture !== true) {
      layer.preferCapture = true;
      count++;
    }
  }
  return count;
}

async function chromiumModules() {
  const [p, c] = await Promise.all([import('puppeteer-core'), import('@sparticuz/chromium')]);
  return { puppeteer: p.default || p, chromium: c.default || c };
}

async function collectBrowserFidelity(rawUrl, width) {
  const { puppeteer, chromium } = await chromiumModules();
  chromium.setGraphicsMode = false;
  let browser;
  try {
    browser = await puppeteer.launch({
      args: [...chromium.args, '--disable-dev-shm-usage', '--disable-background-timer-throttling'],
      executablePath: await chromium.executablePath(),
      headless: 'shell',
      defaultViewport: { width, height: 1100, deviceScaleFactor: 1 },
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height: 1100, deviceScaleFactor: 1 });
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7' });
    await page.setRequestInterception(true);
    page.on('request', req => {
      try {
        const u = new URL(req.url());
        if (!/^https?:$/.test(u.protocol) || ['media', 'websocket', 'eventsource'].includes(req.resourceType()) ||
          u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.local')) {
          return req.abort('blockedbyclient').catch(() => {});
        }
        return req.continue().catch(() => {});
      } catch { return req.abort('blockedbyclient').catch(() => {}); }
    });
    await page.goto(String(rawUrl), { waitUntil: 'domcontentloaded', timeout: 18000 });
    await Promise.race([
      page.waitForNetworkIdle({ idleTime: 300, timeout: 2500 }).catch(() => {}),
      new Promise(r => setTimeout(r, 2500)),
    ]);
    await Promise.race([
      page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {}),
      new Promise(r => setTimeout(r, 1500)),
    ]);

    await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (const img of document.querySelectorAll('img')) {
        const src = img.getAttribute('data-original') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-lazy');
        if (src) { try { img.src = new URL(src, location.href).href; } catch {} }
        const srcset = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
        if (srcset) { try { img.setAttribute('srcset', srcset); } catch {} }
        try { img.loading = 'eager'; } catch {}
      }
      const root = document.scrollingElement || document.documentElement;
      const total = Math.min(50000, Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0, 1));
      const step = Math.max(700, Math.ceil(total / 38));
      for (let y = 0; y < total; y += step) {
        window.scrollTo(0, y);
        window.dispatchEvent(new Event('scroll'));
        await sleep(65);
      }
      window.scrollTo(0, 0);
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
      await sleep(350);
      const style = document.createElement('style');
      style.id = '__h2f_fidelity_freeze';
      style.textContent = '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
      document.head.appendChild(style);
      await sleep(100);
    });

    return await page.evaluate(() => {
      const round = v => Math.round(v * 100) / 100;
      const num = (v, fallback = 0) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : fallback; };
      const cssColor = value => {
        const m = String(value || '').match(/rgba?\(([^)]+)\)/i);
        if (!m) return { r: 0, g: 0, b: 0, a: 0 };
        const p = m[1].split(',').map(x => Number.parseFloat(x.trim()));
        return {
          r: Math.max(0, Math.min(1, (p[0] || 0) / 255)),
          g: Math.max(0, Math.min(1, (p[1] || 0) / 255)),
          b: Math.max(0, Math.min(1, (p[2] || 0) / 255)),
          a: p.length > 3 && Number.isFinite(p[3]) ? Math.max(0, Math.min(1, p[3])) : 1,
        };
      };
      const visible = e => {
        if (!(e instanceof Element)) return false;
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        return r.width > .5 && r.height > .5 && s.display !== 'none' && s.visibility !== 'hidden' && num(s.opacity, 1) > .01;
      };
      const name = (e, suffix = '') => ((e.tagName || 'node').toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList && e.classList.length ? '.' + Array.from(e.classList).slice(0, 2).join('.') : '') + suffix).slice(0, 100);
      const rectBase = (e, s) => {
        const r = e.getBoundingClientRect();
        return {
          x: round(r.left + scrollX), y: round(r.top + scrollY),
          absX: round(r.left + scrollX), absY: round(r.top + scrollY),
          width: round(r.width), height: round(r.height), opacity: num(s.opacity, 1),
        };
      };
      const serializeSvg = svg => {
        const clone = svg.cloneNode(true);
        const source = [svg, ...svg.querySelectorAll('*')];
        const target = [clone, ...clone.querySelectorAll('*')];
        const props = ['color', 'fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'opacity', 'stop-color', 'stop-opacity', 'vector-effect'];
        for (let i = 0; i < Math.min(source.length, target.length); i++) {
          const s = getComputedStyle(source[i]);
          for (const prop of props) {
            const value = s.getPropertyValue(prop);
            if (!value || value === 'normal') continue;
            try { target[i].setAttribute(prop, value); } catch {}
          }
          try { target[i].removeAttribute('class'); } catch {}
        }
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        return clone.outerHTML;
      };

      const svgs = [];
      for (const svg of document.querySelectorAll('svg')) {
        if (svg.closest('svg svg') || !visible(svg)) continue;
        const s = getComputedStyle(svg), b = rectBase(svg, s);
        if (b.width > 5000 || b.height > 5000) continue;
        const serialized = serializeSvg(svg);
        if (serialized.length > 180000) continue;
        svgs.push({ kind: 'svg', name: name(svg), ...b, svg: serialized, zIndex: Number.parseInt(s.zIndex, 10) || 0, stackPath: [100], paintPhase: 2 });
        if (svgs.length >= 220) break;
      }

      const fixed = [];
      const fixedRoots = Array.from(document.querySelectorAll('body *')).filter(e => {
        if (!(e instanceof HTMLElement) || !visible(e)) return false;
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        return (s.position === 'fixed' || s.position === 'sticky') && r.bottom > 0 && r.top < Math.min(innerHeight, 320) && r.width > 80 && r.height > 12;
      }).slice(0, 12);
      const textSeen = new Set();
      for (const root of fixedRoots) {
        const rs = getComputedStyle(root), rb = rectBase(root, rs), bg = cssColor(rs.backgroundColor);
        if (bg.a > .01 && rb.width <= innerWidth * 1.2 && rb.height <= 400) {
          fixed.push({ kind: 'shape', name: name(root, ' — fixed фон'), ...rb, fill: { kind: 'solid', color: bg }, radius: num(rs.borderRadius), zIndex: 100000, stackPath: [100000], paintPhase: 0 });
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 220) continue;
          const el = node.parentElement;
          if (!el || !visible(el)) continue;
          const s = getComputedStyle(el), r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const key = text.toLowerCase() + '|' + Math.round(r.left) + '|' + Math.round(r.top);
          if (textSeen.has(key)) continue;
          textSeen.add(key);
          fixed.push({
            kind: 'text', name: name(el, ' — fixed текст'), x: round(r.left + scrollX), y: round(r.top + scrollY), absX: round(r.left + scrollX), absY: round(r.top + scrollY), width: round(r.width), height: round(r.height), opacity: num(s.opacity, 1), text,
            fontSize: num(s.fontSize, 16), fontWeight: num(s.fontWeight, 400), fontFamily: String(s.fontFamily || 'Inter').split(',')[0].replace(/["']/g, ''), fontStyle: s.fontStyle, lineHeight: num(s.lineHeight, num(s.fontSize, 16) * 1.2), letterSpacing: s.letterSpacing === 'normal' ? 0 : num(s.letterSpacing), textAlign: String(s.textAlign).toUpperCase() === 'CENTER' ? 'CENTER' : String(s.textAlign).toUpperCase() === 'RIGHT' ? 'RIGHT' : 'LEFT', fill: { kind: 'solid', color: cssColor(s.color) }, expectedLineCount: Math.max(1, Math.round(r.height / Math.max(1, num(s.lineHeight, num(s.fontSize, 16) * 1.2)))), textSizing: 'FIXED', zIndex: 100001, stackPath: [100000], paintPhase: 2,
          });
          if (fixed.length >= 160) break;
        }
        if (fixed.length >= 160) break;
      }

      const pseudos = [];
      const elements = Array.from(document.querySelectorAll('body *')).slice(0, 1800);
      for (const el of elements) {
        if (!(el instanceof HTMLElement) || !visible(el)) continue;
        const er = el.getBoundingClientRect();
        for (const pseudo of ['::before', '::after']) {
          const s = getComputedStyle(el, pseudo);
          if (!s || s.display === 'none' || s.visibility === 'hidden' || num(s.opacity, 1) <= .01) continue;
          const rawContent = String(s.content || '');
          const content = rawContent && rawContent !== 'none' && rawContent !== 'normal' ? rawContent.replace(/^['"]|['"]$/g, '') : '';
          const bg = cssColor(s.backgroundColor), borderWidth = Math.max(num(s.borderTopWidth), num(s.borderRightWidth), num(s.borderBottomWidth), num(s.borderLeftWidth));
          const hasVisual = bg.a > .01 || s.backgroundImage !== 'none' || borderWidth > .1 || (content && content !== '""' && content !== "''");
          if (!hasVisual) continue;
          if (!['absolute', 'fixed'].includes(s.position)) continue;
          const w = num(s.width), h = num(s.height);
          if (w < .5 || h < .5 || w > 1200 || h > 1200) continue;
          const left = s.left !== 'auto' ? num(s.left) : null, right = s.right !== 'auto' ? num(s.right) : null, top = s.top !== 'auto' ? num(s.top) : null, bottom = s.bottom !== 'auto' ? num(s.bottom) : null;
          const x = s.position === 'fixed' ? (left != null ? left : right != null ? innerWidth - right - w : er.left) : er.left + (left != null ? left : right != null ? er.width - right - w : 0);
          const y = s.position === 'fixed' ? (top != null ? top : bottom != null ? innerHeight - bottom - h : er.top) : er.top + (top != null ? top : bottom != null ? er.height - bottom - h : 0);
          const base = { x: round(x + scrollX), y: round(y + scrollY), absX: round(x + scrollX), absY: round(y + scrollY), width: round(w), height: round(h), opacity: num(s.opacity, 1), zIndex: Number.parseInt(s.zIndex, 10) || 0, stackPath: [50], paintPhase: 2 };
          if (bg.a > .01 || borderWidth > .1) {
            pseudos.push({ kind: 'shape', name: name(el, ' ' + pseudo), ...base, fill: bg.a > .01 ? { kind: 'solid', color: bg } : undefined, stroke: borderWidth > .1 ? cssColor(s.borderTopColor) : undefined, strokeWeight: borderWidth > .1 ? borderWidth : undefined, radius: num(s.borderRadius) });
          }
          if (content && content !== '""' && content !== "''" && !/^url\(/i.test(content)) {
            pseudos.push({ kind: 'text', name: name(el, ' ' + pseudo + ' — текст'), ...base, text: content, fontSize: num(s.fontSize, 16), fontWeight: num(s.fontWeight, 400), fontFamily: String(s.fontFamily || 'Inter').split(',')[0].replace(/["']/g, ''), fontStyle: s.fontStyle, lineHeight: num(s.lineHeight, num(s.fontSize, 16) * 1.2), letterSpacing: s.letterSpacing === 'normal' ? 0 : num(s.letterSpacing), textAlign: 'CENTER', fill: { kind: 'solid', color: cssColor(s.color) }, expectedLineCount: 1, textSizing: 'FIXED' });
          }
          if (pseudos.length >= 160) break;
        }
        if (pseudos.length >= 160) break;
      }
      return { svgs, fixed, pseudos };
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function mergeBrowserFidelity(snapshot, supplement) {
  const stats = { svgResolved: 0, fixedRecovered: 0, pseudoRecovered: 0 };
  if (!snapshot || !Array.isArray(snapshot.layers) || !supplement) return stats;

  for (const incoming of supplement.svgs || []) {
    const existing = snapshot.layers.find(layer => layer && layer.kind === 'svg' && near(layer, incoming, 7));
    if (existing) {
      if (incoming.svg && existing.svg !== incoming.svg) { existing.svg = incoming.svg; stats.svgResolved++; }
      continue;
    }
    incoming.sectionId = sectionForY(snapshot, Number(incoming.absY ?? incoming.y) || 0);
    if (!isDuplicate(snapshot, incoming)) { snapshot.layers.push(incoming); stats.svgResolved++; }
  }

  for (const incoming of supplement.fixed || []) {
    incoming.sectionId = sectionForY(snapshot, Number(incoming.absY ?? incoming.y) || 0);
    if (!isDuplicate(snapshot, incoming)) { snapshot.layers.push(incoming); stats.fixedRecovered++; }
  }

  for (const incoming of supplement.pseudos || []) {
    incoming.sectionId = sectionForY(snapshot, Number(incoming.absY ?? incoming.y) || 0);
    if (!isDuplicate(snapshot, incoming)) { snapshot.layers.push(incoming); stats.pseudoRecovered++; }
  }
  return stats;
}

function requestUrl(req, result) {
  if (result && result.body && result.body.finalUrl) return String(result.body.finalUrl);
  if (req && req.method === 'GET' && req.query) {
    const raw = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
    if (raw) return String(raw);
  }
  return '';
}

module.exports = async function handler(req, res) {
  try {
    const result = await mockRun(renderCore, req);
    if (result.kind === 'json' && result.body && result.body.snapshot && Array.isArray(result.body.snapshot.layers)) {
      const snapshot = result.body.snapshot;
      const pageBackground = materializePageBackground(snapshot);
      const removed = removeTransientTildaNotifications(snapshot);
      const stacking = raiseCardBackgroundsAboveHeroMedia(snapshot);
      const imageCapturesPreferred = markReliableImageCaptures(snapshot);
      let merged = { svgResolved: 0, fixedRecovered: 0, pseudoRecovered: 0 };
      let fidelityPass = 'skipped';

      const rawUrl = requestUrl(req, result);
      const width = Math.max(320, Math.min(1920, Number(snapshot.width) || Number(req && req.query && req.query.width) || 1440));
      if (rawUrl && /^https?:\/\//i.test(rawUrl) && req.method === 'GET') {
        try {
          const supplement = await collectBrowserFidelity(rawUrl, width);
          merged = mergeBrowserFidelity(snapshot, supplement);
          fidelityPass = 'ok';
        } catch (error) {
          fidelityPass = 'degraded:' + String(error && error.message ? error.message : error).slice(0, 160);
        }
      }

      snapshot.fidelityPass = fidelityPass;
      result.body.stats = {
        ...(result.body.stats || {}),
        pageBackgroundLayers: Number(result.body.stats && result.body.stats.pageBackgroundLayers || 0) + pageBackground,
        popupLayersRemoved: Number(result.body.stats && result.body.stats.popupLayersRemoved || 0) + removed,
        stackingAdjusted: Number(result.body.stats && result.body.stats.stackingAdjusted || 0) + stacking,
        imageCapturesPreferred: Number(result.body.stats && result.body.stats.imageCapturesPreferred || 0) + imageCapturesPreferred,
        svgStylesResolved: Number(result.body.stats && result.body.stats.svgStylesResolved || 0) + merged.svgResolved,
        fixedLayersRecovered: Number(result.body.stats && result.body.stats.fixedLayersRecovered || 0) + merged.fixedRecovered,
        pseudoLayersRecovered: Number(result.body.stats && result.body.stats.pseudoLayersRecovered || 0) + merged.pseudoRecovered,
        fidelityPass,
      };
      result.body.stats.imageLayers = snapshot.layers.filter(x => x && x.kind === 'image').length;
      result.body.stats.layers = snapshot.layers.length;
    }
    return forward(result, res);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error && error.message ? error.message : String(error) });
  }
};

module.exports._test = { markReliableImageCaptures, mergeBrowserFidelity, isDuplicate, near };
