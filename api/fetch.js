const dns = require('node:dns').promises;
const net = require('node:net');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const MAX_LAYERS = 2200;
const MAX_PAGE_HEIGHT = 30000;
const VIEWPORT_HEIGHT = 1000;
const NAV_TIMEOUT_MS = 12000;
const DNS_TIMEOUT_MS = 1200;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase().split('%')[0];
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith('::ffff:')) {
    const v4 = value.slice(7);
    return net.isIP(v4) === 4 ? isPrivateIPv4(v4) : true;
  }
  return false;
}

function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

const hostSafetyCache = new Map();
async function assertPublicUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('Некорректный URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Разрешены только http/https ссылки');
  if (url.username || url.password) throw new Error('URL с логином/паролем не поддерживаются');

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Локальные адреса запрещены');
  }
  if (hostSafetyCache.has(hostname)) {
    if (!hostSafetyCache.get(hostname)) throw new Error('Приватный адрес запрещён');
    return url;
  }
  if (net.isIP(hostname)) {
    const safe = !isPrivateIp(hostname);
    hostSafetyCache.set(hostname, safe);
    if (!safe) throw new Error('Приватные IP-адреса запрещены');
    return url;
  }

  let addresses = [];
  try {
    const [v4, v6] = await withTimeout(Promise.all([
      dns.resolve4(hostname).catch(() => []),
      dns.resolve6(hostname).catch(() => []),
    ]), DNS_TIMEOUT_MS);
    addresses = [...v4, ...v6];
  } catch {
    throw new Error('Не удалось проверить адрес сайта');
  }
  if (!addresses.length) throw new Error('Домен не найден');
  const safe = !addresses.some(isPrivateIp);
  hostSafetyCache.set(hostname, safe);
  if (!safe) throw new Error('Сайт ведёт на приватный IP-адрес');
  return url;
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

function snapshotToHtml(snapshot) {
  const sections = Array.isArray(snapshot.sections) && snapshot.sections.length
    ? snapshot.sections.slice().sort((a, b) => a.y - b.y)
    : [{ id: 'section-0', name: 'page', y: 0, height: snapshot.height || 1 }];
  const byId = new Map(sections.map((s) => [s.id, []]));
  for (const layer of snapshot.layers || []) {
    let id = layer.sectionId;
    if (!byId.has(id)) {
      const y = Number(layer.y) || 0;
      const match = sections.find((s) => y >= s.y - 2 && y <= s.y + s.height + 2);
      id = match ? match.id : sections[0].id;
    }
    byId.get(id).push(layer);
  }

  const sectionHtml = sections.map((section, index) => {
    const layers = (byId.get(section.id) || []).sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0));
    const items = layers.map((layer) => {
      const localY = (Number(layer.y) || 0) - (Number(section.y) || 0);
      const style = [
        'position:absolute',
        `left:${Number(layer.x) || 0}px`,
        `top:${Number(localY) || 0}px`,
        `width:${Math.max(1, Number(layer.width) || 1)}px`,
        `height:${Math.max(1, Number(layer.height) || 1)}px`,
        `opacity:${Math.max(0.01, Math.min(1, Number(layer.opacity) || 1))}`,
        `z-index:${Number(layer.z) || 0}`,
        'box-sizing:border-box',
      ];
      if (layer.radius) style.push(`border-radius:${Number(layer.radius) || 0}px`);
      if (layer.shadow) style.push(`box-shadow:${Number(layer.shadow.x) || 0}px ${Number(layer.shadow.y) || 0}px ${Number(layer.shadow.blur) || 0}px ${Number(layer.shadow.spread) || 0}px ${cssColor(layer.shadow.color)}`);

      if (layer.kind === 'image' && layer.url) {
        style.push(`object-fit:${layer.imageScaleMode === 'FIT' ? 'contain' : 'cover'}`, 'display:block');
        return `<img data-snapshot-layer="image" src="${escAttr(layer.url)}" style="${style.join(';')}">`;
      }
      if (layer.kind === 'svg' && layer.svg) {
        const svg = String(layer.svg).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<svg\b/i, '<svg style="width:100%;height:100%;display:block"');
        return `<div data-snapshot-layer="svg" style="${style.join(';')}">${svg}</div>`;
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
          'white-space:pre-wrap', 'overflow:hidden', 'margin:0', 'padding:0'
        );
        return `<div data-snapshot-layer="text" style="${style.join(';')}">${escText(layer.text || '')}</div>`;
      }
      if (layer.fill) style.push(`background:${fillCss(layer.fill)}`);
      if (layer.stroke && layer.strokeWeight) style.push(`border:${Number(layer.strokeWeight) || 1}px solid ${cssColor(layer.stroke)}`);
      return `<div data-snapshot-layer="shape" style="${style.join(';')}"></div>`;
    }).join('');

    return `<section data-source-section="${escAttr(section.name || section.id)}" style="position:relative;width:${Number(snapshot.width) || 1440}px;height:${Math.max(1, Number(section.height) || 1)}px;overflow:hidden;margin:0;padding:0">${items}</section>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0!important;padding:0!important;width:${Number(snapshot.width) || 1440}px!important;min-width:${Number(snapshot.width) || 1440}px!important;background:#fff}main{margin:0;padding:0;width:100%}section{display:block}</style></head><body><main>${sectionHtml}</main></body></html>`;
}

async function renderSnapshot(startUrl, width) {
  const safeStart = await assertPublicUrl(startUrl);
  chromium.setGraphicsMode = false;
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: 'shell',
    defaultViewport: { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 });
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7' });
    await page.setRequestInterception(true);

    page.on('request', async (request) => {
      const target = request.url();
      if (/^(data:|blob:|about:)/i.test(target)) {
        try { await request.continue(); } catch {}
        return;
      }
      if (!/^https?:/i.test(target)) {
        try { await request.abort('blockedbyclient'); } catch {}
        return;
      }
      try {
        const type = request.resourceType();
        if (type === 'media' || type === 'websocket' || type === 'eventsource') {
          await request.abort('blockedbyclient');
          return;
        }
        await assertPublicUrl(target);
        await request.continue();
      } catch {
        try { await request.abort('blockedbyclient'); } catch {}
      }
    });

    await page.goto(safeStart.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await Promise.race([
      page.waitForNetworkIdle({ idleTime: 300, timeout: 1600 }).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1700)),
    ]);
    await Promise.race([
      page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);

    await page.evaluate(async (maxHeight) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const root = document.scrollingElement || document.documentElement;
      const total = Math.min(maxHeight, Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0));
      for (let y = 0; y < total; y += 1400) {
        window.scrollTo(0, y);
        await sleep(22);
      }
      window.scrollTo(0, 0);
      await sleep(220);
    }, MAX_PAGE_HEIGHT);

    await page.addStyleTag({ content: '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}' }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 120));

    const finalUrl = page.url();
    await assertPublicUrl(finalUrl);

    const snapshot = await page.evaluate(({ maxLayers, maxHeight, viewportWidth }) => {
      const layers = [];
      const win = window;
      const doc = document;
      let truncated = false;
      let seq = 0;
      const num = (v, f = 0) => { const x = Number.parseFloat(v); return Number.isFinite(x) ? x : f; };
      const round = (v) => Math.round(v * 100) / 100;
      const clean = (v) => String(v || '').replace(/\u00a0/g, ' ').replace(/[\t\r\f\v ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
      const parseColor = (v) => {
        const m = String(v || '').match(/rgba?\(([^)]+)\)/i);
        if (!m) return { r: 0, g: 0, b: 0, a: 0 };
        const p = m[1].split(',').map((x) => Number.parseFloat(x.trim()));
        return { r: (p[0] || 0) / 255, g: (p[1] || 0) / 255, b: (p[2] || 0) / 255, a: p.length > 3 && Number.isFinite(p[3]) ? p[3] : 1 };
      };
      const rect = (r) => ({ x: round(r.left + win.scrollX), y: round(r.top + win.scrollY), width: round(r.width), height: round(r.height) });
      const visible = (r, s) => r.width > .5 && r.height > .5 && s.display !== 'none' && s.visibility !== 'hidden' && num(s.opacity, 1) > .01;
      const name = (e, suffix = '') => ((e.tagName || 'node').toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList && e.classList.length ? '.' + Array.from(e.classList).slice(0, 2).join('.') : '') + suffix).slice(0, 100);
      const add = (layer) => {
        if (layers.length >= maxLayers) { truncated = true; return false; }
        if (!layer || !Number.isFinite(layer.x) || !Number.isFinite(layer.y) || layer.width <= .5 || layer.height <= .5) return true;
        if (layer.y > maxHeight + 1000 || layer.x > viewportWidth + 1000 || layer.x + layer.width < -1000) return true;
        layer.z = seq++;
        layers.push(layer);
        return true;
      };
      const firstUrl = (v) => {
        const m = String(v || '').match(/url\((?:"|')?([^"')]+)(?:"|')?\)/i);
        if (!m || !m[1]) return '';
        try { return new URL(m[1], location.href).href; } catch { return m[1]; }
      };
      const gradient = (v) => {
        const raw = String(v || '');
        if (!raw.includes('linear-gradient(')) return null;
        const cs = Array.from(raw.matchAll(/rgba?\([^)]*\)/gi)).map((m) => parseColor(m[0]));
        if (cs.length < 2) return null;
        const am = raw.match(/linear-gradient\(\s*(-?[\d.]+)deg/i);
        return { kind: 'linear', angle: am ? num(am[1], 180) : 180, stops: cs.slice(0, 8).map((c, i, a) => ({ position: i / Math.max(1, a.length - 1), color: c })) };
      };
      const shadow = (v) => {
        const raw = String(v || '');
        if (!raw || raw === 'none' || raw.includes('inset')) return null;
        const cm = raw.match(/rgba?\([^)]*\)/i);
        const ns = raw.replace(cm ? cm[0] : '', '').match(/-?[\d.]+px/g) || [];
        if (ns.length < 2) return null;
        return { color: parseColor(cm ? cm[0] : 'rgba(0,0,0,.2)'), x: num(ns[0]), y: num(ns[1]), blur: num(ns[2]), spread: num(ns[3]) };
      };
      const radius = (s) => Math.max(num(s.borderTopLeftRadius), num(s.borderTopRightRadius), num(s.borderBottomLeftRadius), num(s.borderBottomRightRadius));
      const textAlign = (v) => { const x = String(v || '').toLowerCase(); return x === 'center' ? 'CENTER' : (x === 'right' || x === 'end') ? 'RIGHT' : x === 'justify' ? 'JUSTIFIED' : 'LEFT'; };
      const family = (v) => String(v || 'Inter').split(',')[0].trim().replace(/^['"]|['"]$/g, '') || 'Inter';
      const lineHeight = (s) => s.lineHeight === 'normal' ? num(s.fontSize, 16) * 1.2 : num(s.lineHeight, num(s.fontSize, 16) * 1.2);
      const textRole = (e, t) => /^H[1-6]$/.test(e.tagName) ? e.tagName : e.matches('button,.t-btn,[role="button"]') ? 'Button' : /^\s*\d{1,3}\s*$/.test(t) ? 'Number' : 'Body';
      const inlineTags = new Set(['SPAN','STRONG','B','EM','I','U','SMALL','SUP','SUB','BR','MARK','CODE']);
      const ownText = (e) => {
        const own = clean(Array.from(e.childNodes || []).filter((x) => x.nodeType === Node.TEXT_NODE).map((x) => x.textContent || '').join(' '));
        if (own) return own;
        if (Array.from(e.children || []).every((c) => inlineTags.has(c.tagName))) return clean(e.innerText || e.textContent || '');
        return '';
      };
      const isText = (e, t) => !!t && (e.matches('.tn-atom,.t-title,.t-descr,.t-text,.t-name,.t-btn,.t-menu__link-item,h1,h2,h3,h4,h5,h6,p,button,label,li,blockquote') || (e.tagName === 'A' && t.length < 220) || (['SPAN','STRONG','B','EM','I','SMALL'].includes(e.tagName) && t.length < 180));

      const candidates = Array.from(doc.querySelectorAll('#allrecords > .t-rec, .t-rec[id], header, main > section, footer'));
      const sectionElements = [];
      const seen = new Set();
      for (const e of candidates) {
        if (seen.has(e)) continue;
        const s = win.getComputedStyle(e), r = e.getBoundingClientRect();
        if (!visible(r, s)) continue;
        seen.add(e); sectionElements.push(e);
      }
      if (!sectionElements.length && doc.body) {
        for (const e of Array.from(doc.body.children)) {
          const s = win.getComputedStyle(e), r = e.getBoundingClientRect();
          if (visible(r, s)) sectionElements.push(e);
        }
      }
      const sectionMap = new Map();
      const sections = sectionElements.map((e, i) => {
        const r = e.getBoundingClientRect(), id = 'section-' + i;
        sectionMap.set(e, id);
        return { id, name: (e.id || (e.classList && e.classList[0]) || e.tagName.toLowerCase()).slice(0, 90), y: round(r.top + win.scrollY), height: Math.max(1, round(r.height)) };
      });
      const sectionFor = (e, r) => {
        const closest = e.closest ? e.closest('.t-rec,header,section,footer') : null;
        if (closest && sectionMap.has(closest)) return sectionMap.get(closest);
        const y = r.top + win.scrollY + Math.min(8, r.height / 2);
        const hit = sections.find((s) => y >= s.y - 2 && y <= s.y + s.height + 2);
        return hit ? hit.id : (sections[0] ? sections[0].id : undefined);
      };

      function walk(e, suppressText) {
        if (truncated || !(e instanceof HTMLElement || e instanceof SVGElement)) return;
        const s = win.getComputedStyle(e), r = e.getBoundingClientRect();
        if (!visible(r, s)) return;
        const base = rect(r), sectionId = sectionFor(e, r), opacity = num(s.opacity, 1), rad = radius(s);
        if (e instanceof SVGElement && e.tagName.toLowerCase() === 'svg') {
          add({ kind: 'svg', name: name(e), ...base, opacity, svg: e.outerHTML.slice(0, 180000), sectionId });
          return;
        }
        if (e.tagName === 'IMG') {
          const url = e.currentSrc || e.getAttribute('src') || e.getAttribute('data-original') || e.getAttribute('data-src') || '';
          if (url) add({ kind: 'image', name: name(e), ...base, opacity, url, radius: rad, imageScaleMode: String(s.objectFit || '').toLowerCase() === 'contain' ? 'FIT' : 'FILL', sectionId });
          return;
        }
        const bgUrl = firstUrl(s.backgroundImage);
        if (bgUrl) add({ kind: 'image', name: name(e, ' — фон'), ...base, opacity, url: bgUrl, radius: rad, imageScaleMode: String(s.backgroundSize || '').includes('contain') ? 'FIT' : 'FILL', sectionId });
        else {
          const bg = parseColor(s.backgroundColor), borderWidth = Math.max(num(s.borderTopWidth), num(s.borderRightWidth), num(s.borderBottomWidth), num(s.borderLeftWidth)), sh = shadow(s.boxShadow), gr = gradient(s.backgroundImage);
          if (e !== doc.body && e !== doc.documentElement && (bg.a > .01 || borderWidth > .1 || sh || gr)) {
            add({ kind: 'shape', name: name(e, ' — фон'), ...base, opacity, fill: gr || (bg.a > .01 ? { kind: 'solid', color: bg } : undefined), stroke: borderWidth > .1 ? parseColor(s.borderTopColor) : undefined, strokeWeight: borderWidth || undefined, radius: rad || undefined, shadow: sh || undefined, sectionId });
          }
        }
        let captured = false;
        if (!suppressText) {
          const t = ownText(e);
          if (isText(e, t)) {
            add({ kind: 'text', name: name(e, ' — текст'), ...base, opacity, fill: { kind: 'solid', color: parseColor(s.color) }, text: t, textRole: textRole(e, t), fontSize: num(s.fontSize, 16), fontWeight: num(s.fontWeight, 400), fontFamily: family(s.fontFamily), lineHeight: lineHeight(s), letterSpacing: s.letterSpacing === 'normal' ? 0 : num(s.letterSpacing), textAlign: textAlign(s.textAlign), textSizing: 'FIXED', sectionId });
            captured = true;
          }
        }
        for (const child of Array.from(e.children || [])) walk(child, suppressText || captured);
      }

      if (doc.body) walk(doc.body, false);
      const root = doc.scrollingElement || doc.documentElement;
      const height = Math.min(maxHeight, Math.max(root.scrollHeight, doc.body ? doc.body.scrollHeight : 0, 1));
      return { width: viewportWidth, height, sections, layers, truncated };
    }, { maxLayers: MAX_LAYERS, maxHeight: MAX_PAGE_HEIGHT, viewportWidth: width });

    return { finalUrl, snapshot };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Разрешены только GET и OPTIONS' });

  const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  const rawWidth = Array.isArray(req.query.width) ? req.query.width[0] : req.query.width;
  const width = Math.max(320, Math.min(1920, Number(rawWidth) || 1440));
  if (!rawUrl) return res.status(400).json({ ok: false, error: 'Не передан параметр url' });

  try {
    const { finalUrl, snapshot } = await renderSnapshot(String(rawUrl), width);
    const html = snapshotToHtml(snapshot);
    if (html.length > 2900000) throw new Error('Отрендерированный снимок страницы превышает лимит 2.9 МБ');
    return res.status(200).json({
      ok: true,
      mode: 'browser-static-html',
      finalUrl,
      html,
      stats: { layers: snapshot.layers.length, sections: snapshot.sections.length, height: snapshot.height, truncated: snapshot.truncated },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось отрендерить страницу';
    return res.status(502).json({ ok: false, error: message });
  }
};
