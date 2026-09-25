const renderCore = require('./render17');

const VERSION = 22;
const POPUP_RE = /(cookie|cookies|consent|gdpr|cookieyes|cky[-_]|cmplz|t-cookie|tildacookie|popup|pop-up|modal|dialog|pum-|popmake|jet-popup|elementor-popup|complianz|onetrust|cookiebot)/i;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}

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

function frameworkOf(snapshot) {
  const layers = Array.isArray(snapshot && snapshot.layers) ? snapshot.layers : [];
  let elementor = 0;
  let tilda = 0;
  for (const layer of layers.slice(0, 1200)) {
    const probe = `${layer && layer.name || ''} ${layer && layer.sectionId || ''}`.toLowerCase();
    if (/elementor|e-con|e-flex/.test(probe)) elementor++;
    if (/\bt\d{3}\b|t-rec|t396|tn-elem|t-slds|tilda/.test(probe)) tilda++;
  }
  if (elementor >= 2 && elementor > tilda) return 'elementor';
  if (tilda >= 2) return 'tilda';
  return 'generic';
}

function removeKnownPopups(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.layers)) return { snapshot, removed: 0 };
  const blockedContainers = new Set();
  for (const layer of snapshot.layers) {
    if (!layer || layer.kind !== 'container' || !layer.containerKey) continue;
    if (POPUP_RE.test(`${layer.name || ''} ${layer.text || ''}`)) blockedContainers.add(layer.containerKey);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const layer of snapshot.layers) {
      if (!layer || layer.kind !== 'container' || !layer.containerKey || !layer.parentContainerKey) continue;
      if (blockedContainers.has(layer.parentContainerKey) && !blockedContainers.has(layer.containerKey)) {
        blockedContainers.add(layer.containerKey);
        changed = true;
      }
    }
  }
  let removed = 0;
  const layers = snapshot.layers.filter(layer => {
    if (!layer) return false;
    const text = String(layer.text || '');
    const name = String(layer.name || '');
    const explicitCookieText = /(?:файл(?:ы|ов)?\s+cookie|используем\s+cookie|настройк[аи]\s+cookie|политик[аи]\s+cookie)/i.test(text);
    const blocked = POPUP_RE.test(name) || explicitCookieText || (layer.parentContainerKey && blockedContainers.has(layer.parentContainerKey));
    if (blocked) removed++;
    return !blocked;
  });
  return { snapshot: { ...snapshot, layers }, removed };
}

function stabilizeText(snapshot) {
  let adjusted = 0;
  for (const layer of snapshot.layers || []) {
    if (!layer || layer.kind !== 'text' || !layer.text) continue;
    const fs = Math.max(4, Number(layer.fontSize) || 16);
    const lh = Math.max(fs, Number(layer.lineHeight) || fs * 1.2);
    const lines = Math.max(1, String(layer.text).split('\n').length, Number(layer.expectedLineCount) || 1);
    const minHeight = lh * lines + Math.max(2, fs * 0.14);
    if ((Number(layer.height) || 0) < minHeight) {
      layer.height = Math.round(minHeight * 100) / 100;
      adjusted++;
    }
    if (lines === 1) {
      const w = Math.max(1, Number(layer.width) || 1);
      const spare = Math.min(14, Math.max(3, w * 0.035));
      layer.width = Math.round((w + spare) * 100) / 100;
    }
    layer.expectedLineCount = lines;
  }
  return adjusted;
}

function areaOverlap(a, b) {
  const ax = Number(a.absX ?? a.x) || 0, ay = Number(a.absY ?? a.y) || 0;
  const bx = Number(b.absX ?? b.x) || 0, by = Number(b.absY ?? b.y) || 0;
  const ix = Math.max(0, Math.min(ax + a.width, bx + b.width) - Math.max(ax, bx));
  const iy = Math.max(0, Math.min(ay + a.height, by + b.height) - Math.max(ay, by));
  return ix * iy;
}

function fixLargeImageUnderCards(snapshot) {
  const layers = Array.isArray(snapshot.layers) ? snapshot.layers : [];
  let adjusted = 0;
  const cards = layers.filter(l => {
    if (!l || !['shape', 'container'].includes(l.kind)) return false;
    if (!l.fill || l.fill.kind !== 'solid' || !l.fill.color || Number(l.fill.color.a) < 0.55) return false;
    const y = Number(l.absY ?? l.y) || 0;
    return y < 1250 && l.width >= 90 && l.height >= 45 && l.width <= 760 && l.height <= 560;
  });
  for (const img of layers) {
    if (!img || img.kind !== 'image') continue;
    const name = String(img.name || '').toLowerCase();
    if (/section background|background image|фон/.test(name) || Number(img.zIndex) < -1000 || img.captureMode === 'background') continue;
    const y = Number(img.absY ?? img.y) || 0;
    if (y >= 1250 || img.width < 240 || img.height < 240) continue;
    let hits = 0;
    for (const card of cards) {
      if (img.sectionId && card.sectionId && img.sectionId !== card.sectionId) continue;
      const inter = areaOverlap(img, card);
      const cardArea = Math.max(1, card.width * card.height);
      if (inter / cardArea >= 0.08) hits++;
    }
    if (hits >= 2) {
      img.stackPath = [];
      img.zIndex = -10;
      img.paintPhase = 0;
      img.z = -1000;
      adjusted++;
    }
  }
  return adjusted;
}

async function chromiumModules() {
  const [p, c] = await Promise.all([import('puppeteer-core'), import('@sparticuz/chromium')]);
  return { puppeteer: p.default || p, chromium: c.default || c };
}

function sectionForY(snapshot, y) {
  const sections = Array.isArray(snapshot.sections) ? snapshot.sections : [];
  const hit = sections.find(s => y >= Number(s.y || 0) - 2 && y <= Number(s.y || 0) + Number(s.height || 0) + 2);
  return hit ? hit.id : (sections[0] ? sections[0].id : undefined);
}

function sameText(a, b) {
  const n = v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return n(a) === n(b);
}

function isDuplicate(snapshot, candidate) {
  const cx = Number(candidate.absX ?? candidate.x) || 0;
  const cy = Number(candidate.absY ?? candidate.y) || 0;
  for (const layer of snapshot.layers || []) {
    if (!layer || layer.kind !== candidate.kind) continue;
    const lx = Number(layer.absX ?? layer.x) || 0;
    const ly = Number(layer.absY ?? layer.y) || 0;
    if (Math.abs(lx - cx) > 8 || Math.abs(ly - cy) > 8) continue;
    if (candidate.kind === 'text' && !sameText(layer.text, candidate.text)) continue;
    if (candidate.kind === 'image') {
      const a = String(layer.sourceUrl || layer.url || '').split('?')[0];
      const b = String(candidate.sourceUrl || candidate.url || '').split('?')[0];
      if (a && b && a !== b) continue;
    }
    return true;
  }
  return false;
}

async function collectHiddenElementor(rawUrl, width, snapshot) {
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
        if (!/^https?:$/.test(u.protocol) || ['media', 'websocket', 'eventsource'].includes(req.resourceType()) || u.hostname === 'localhost' || u.hostname.endsWith('.local')) return req.abort('blockedbyclient').catch(() => {});
        return req.continue().catch(() => {});
      } catch { return req.abort('blockedbyclient').catch(() => {}); }
    });
    await page.goto(String(rawUrl), { waitUntil: 'domcontentloaded', timeout: 18000 });
    await Promise.race([page.waitForNetworkIdle({ idleTime: 300, timeout: 2500 }).catch(() => {}), new Promise(r => setTimeout(r, 2500))]);

    const isElementor = await page.evaluate(() => !!document.querySelector('.elementor,[data-elementor-id]') || /elementor/i.test(document.querySelector('meta[name="generator"]')?.getAttribute('content') || ''));
    if (!isElementor) return { layers: [], revealedRoots: 0 };

    const revealedRoots = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('.elementor-invisible,[data-settings*="animation"],[data-settings*="_animation"]'));
      let count = 0;
      for (const el of candidates) {
        if (!(el instanceof HTMLElement)) continue;
        const cs = getComputedStyle(el);
        const hidden = el.classList.contains('elementor-invisible') || cs.visibility === 'hidden' || Number.parseFloat(cs.opacity || '1') <= .01;
        if (!hidden) continue;
        el.setAttribute('data-h2f-reveal-root', '1');
        el.classList.remove('elementor-invisible');
        el.style.setProperty('visibility', 'visible', 'important');
        el.style.setProperty('opacity', '1', 'important');
        count++;
      }
      const st = document.createElement('style');
      st.id = '__h2f_v22';
      st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;animation-delay:0s!important;animation-duration:0s!important} [data-h2f-reveal-root="1"]{visibility:visible!important;opacity:1!important}';
      document.head.appendChild(st);
      return count;
    });
    if (!revealedRoots) return { layers: [], revealedRoots: 0 };

    await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const root = document.scrollingElement || document.documentElement;
      const total = Math.min(30000, Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0, 1));
      for (let y = 0; y < total; y += 900) { window.scrollTo(0, y); await sleep(55); }
      window.scrollTo(0, 0);
      await sleep(120);
    });

    const extra = await page.evaluate(() => {
      const out = [];
      const win = window;
      const num = (v, f = 0) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : f; };
      const round = v => Math.round(v * 100) / 100;
      const color = v => {
        const m = String(v || '').match(/rgba?\(([^)]+)\)/i);
        if (!m) return { r: 0, g: 0, b: 0, a: 0 };
        const p = m[1].split(',').map(x => Number.parseFloat(x.trim()));
        return { r: Math.max(0, Math.min(1, (p[0] || 0) / 255)), g: Math.max(0, Math.min(1, (p[1] || 0) / 255)), b: Math.max(0, Math.min(1, (p[2] || 0) / 255)), a: p.length > 3 && Number.isFinite(p[3]) ? Math.max(0, Math.min(1, p[3])) : 1 };
      };
      const visible = e => {
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        return r.width > .5 && r.height > .5 && s.display !== 'none' && s.visibility !== 'hidden' && num(s.opacity, 1) > .01;
      };
      const nm = (e, suffix = '') => ((e.tagName || 'node').toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList && e.classList.length ? '.' + Array.from(e.classList).slice(0, 2).join('.') : '') + suffix).slice(0, 100);
      const roots = Array.from(document.querySelectorAll('[data-h2f-reveal-root="1"]'));
      const nodes = new Set();
      for (const root of roots) {
        nodes.add(root);
        root.querySelectorAll('*').forEach(x => nodes.add(x));
      }
      let seq = 0;
      for (const e of nodes) {
        if (!(e instanceof HTMLElement || e instanceof SVGElement) || !visible(e)) continue;
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        const absX = round(r.left + win.scrollX), absY = round(r.top + win.scrollY), width = round(r.width), height = round(r.height);
        const zi = Number.isFinite(Number.parseInt(s.zIndex, 10)) ? Number.parseInt(s.zIndex, 10) : 0;
        const base = { absX, absY, x: absX, y: absY, width, height, opacity: num(s.opacity, 1), zIndex: zi, stackPath: [500], z: seq++ };

        if (e instanceof HTMLImageElement) {
          const u = e.currentSrc || e.src || e.getAttribute('data-src') || e.getAttribute('data-lazy-src') || '';
          if (u) out.push({ ...base, kind: 'image', name: nm(e, ' — revealed image'), url: u, sourceUrl: u, imageScaleMode: String(s.objectFit || '').toLowerCase() === 'contain' ? 'FIT' : 'FILL', paintPhase: 1 });
          continue;
        }
        if (e instanceof SVGElement && e.tagName.toLowerCase() === 'svg' && !e.closest('svg svg')) {
          out.push({ ...base, kind: 'svg', name: nm(e, ' — revealed svg'), svg: e.outerHTML.slice(0, 180000), paintPhase: 1 });
          continue;
        }

        const directNodes = Array.from(e.childNodes || []).filter(n => n.nodeType === 3 && String(n.nodeValue || '').trim());
        if (directNodes.length) {
          const words = [];
          let order = 0;
          for (const tn of directNodes) {
            const raw = tn.nodeValue || '';
            for (const m of raw.matchAll(/\S+/g)) {
              const start = m.index || 0, end = start + m[0].length, rg = document.createRange();
              try { rg.setStart(tn, start); rg.setEnd(tn, end); } catch { continue; }
              const q = rg.getBoundingClientRect();
              if (q.width > .2 && q.height > .2) words.push({ t: m[0], x: q.left + win.scrollX, y: q.top + win.scrollY, w: q.width, h: q.height, o: order++ });
            }
          }
          if (words.length) {
            words.sort((a, b) => Math.abs(a.y - b.y) > 1.5 ? a.y - b.y : a.x - b.x || a.o - b.o);
            const lines = [];
            for (const w of words) { let line = lines.find(l => Math.abs(l.y - w.y) < Math.max(2, w.h * .35)); if (!line) { line = { y: w.y, items: [] }; lines.push(line); } line.items.push(w); }
            lines.sort((a, b) => a.y - b.y);
            const text = lines.map(l => l.items.sort((a, b) => a.x - b.x || a.o - b.o).map(x => x.t).join(' ')).join('\n');
            const minY = Math.min(...words.map(w => w.y)), maxY = Math.max(...words.map(w => w.y + w.h));
            const fs = num(s.fontSize, 16), lh = s.lineHeight === 'normal' ? fs * 1.2 : num(s.lineHeight, fs * 1.2), ta = String(s.textAlign || 'left').toUpperCase();
            out.push({ ...base, kind: 'text', name: nm(e, ' — revealed text'), absY: round(minY), y: round(minY), height: round(Math.max(maxY - minY, lh * lines.length + fs * .14)), text, expectedLineCount: lines.length, fill: { kind: 'solid', color: color(s.color) }, textRole: /^H[1-6]$/.test(e.tagName) ? e.tagName : (e.matches('button,.elementor-button,[role="button"]') ? 'Button' : 'Body'), fontSize: fs, fontWeight: num(s.fontWeight, 400), fontFamily: String(s.fontFamily || 'Inter').split(',')[0].trim().replace(/^['"]|['"]$/g, ''), fontStyle: String(s.fontStyle || 'normal'), lineHeight: lh, letterSpacing: s.letterSpacing === 'normal' ? 0 : num(s.letterSpacing), textAlign: ta === 'CENTER' ? 'CENTER' : ta === 'RIGHT' || ta === 'END' ? 'RIGHT' : ta === 'JUSTIFY' ? 'JUSTIFIED' : 'LEFT', textDecoration: String(s.textDecorationLine || 'none'), textSizing: 'FIXED', paintPhase: 2 });
          }
        }

        const bg = color(s.backgroundColor), bw = Math.max(num(s.borderTopWidth), num(s.borderRightWidth), num(s.borderBottomWidth), num(s.borderLeftWidth));
        const isControl = e.matches('button,.elementor-button,[role="button"],a[class*="button"],a[class*="btn"]');
        if ((isControl || bg.a > .03 || bw > .1) && width >= 18 && height >= 14 && width <= 1200 && height <= 900) {
          out.push({ ...base, kind: 'shape', name: nm(e, ' — revealed shape'), fill: bg.a > .03 ? { kind: 'solid', color: bg } : undefined, stroke: bw > .1 ? color(s.borderTopColor) : undefined, strokeWeight: bw || undefined, radius: Math.max(num(s.borderTopLeftRadius), num(s.borderTopRightRadius), num(s.borderBottomLeftRadius), num(s.borderBottomRightRadius)) || undefined, paintPhase: 0 });
        }
      }
      return out.slice(0, 900);
    });

    const layers = [];
    for (const candidate of extra) {
      candidate.sectionId = sectionForY(snapshot, Number(candidate.absY ?? candidate.y) || 0);
      if (!isDuplicate(snapshot, candidate)) layers.push(candidate);
    }
    return { layers, revealedRoots };
  } catch {
    return { layers: [], revealedRoots: 0 };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ ok: false, error: 'Разрешены только GET, POST и OPTIONS' });

  if (req.method === 'GET' && String(req.query && req.query.ping || '') === '1') {
    return res.status(200).json({
      ok: true,
      service: 'browser-renderer',
      version: VERSION,
      architecture: 'v17-core-targeted-fidelity',
      geometryFirst: true,
      textFidelity: true,
      elementorReveal: true,
      overlapStacking: true,
      visualQa: true,
    });
  }

  try {
    const result = await mockRun(renderCore, req);
    if (result.kind !== 'json' || !result.body || result.statusCode !== 200 || !result.body.snapshot) return forward(result, res);

    const filtered = removeKnownPopups(result.body.snapshot);
    const snapshot = filtered.snapshot;
    const framework = frameworkOf(snapshot);
    const textAdjusted = stabilizeText(snapshot);
    const stackingAdjusted = fixLargeImageUnderCards(snapshot);

    let revealed = { layers: [], revealedRoots: 0 };
    if (framework === 'elementor') {
      const rawUrl = result.body.finalUrl || (req.method === 'POST' ? req.body && req.body.url : req.query && req.query.url);
      const rawWidth = req.method === 'POST' ? req.body && req.body.width : req.query && req.query.width;
      const width = Math.max(320, Math.min(1920, Number(rawWidth) || Number(snapshot.width) || 1440));
      if (rawUrl) revealed = await collectHiddenElementor(String(rawUrl), width, snapshot);
      if (revealed.layers.length) {
        snapshot.layers.push(...revealed.layers);
        stabilizeText(snapshot);
      }
    }

    snapshot.rendererVersion = VERSION;
    snapshot.framework = framework;
    snapshot.popupSuppression = true;
    snapshot.geometryPolicy = 'browser-absolute';

    const imageLayers = snapshot.layers.filter(x => x && x.kind === 'image').length;
    return res.status(200).json({
      ...result.body,
      mode: 'browser-snapshot-v22-fidelity',
      snapshot,
      stats: {
        ...(result.body.stats || {}),
        rendererVersion: VERSION,
        framework,
        layers: snapshot.layers.length,
        sections: Array.isArray(snapshot.sections) ? snapshot.sections.length : 0,
        imageLayers,
        popupLayersRemoved: filtered.removed,
        textBoxesStabilized: textAdjusted,
        stackingAdjusted,
        elementorRevealedRoots: revealed.revealedRoots,
        elementorSupplementLayers: revealed.layers.length,
        tildaTextFidelity: snapshot.tildaTextFidelity || null,
        geometryPolicy: 'browser-absolute',
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error && error.message ? error.message : String(error) });
  }
};
