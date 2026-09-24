const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_LAYERS = 3600;
const MAX_HEIGHT = 60000;
const NAV_TIMEOUT = 18000;
const VIEWPORT_HEIGHT = 1100;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}

function isPrivateV4(ip) {
  const p = String(ip || '').split('.').map(Number);
  if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function isPrivateV6(ip) {
  const s = String(ip || '').toLowerCase().split('%')[0];
  if (s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || /^fe[89ab]/.test(s)) return true;
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice(7);
    return net.isIP(v4) === 4 ? isPrivateV4(v4) : true;
  }
  return false;
}
function isPrivateIp(ip) {
  const t = net.isIP(ip);
  return t === 4 ? isPrivateV4(ip) : t === 6 ? isPrivateV6(ip) : true;
}
const dnsCache = new Map();
async function hostIsPublic(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (net.isIP(host)) return !isPrivateIp(host);
  if (dnsCache.has(host)) return dnsCache.get(host);
  const p = Promise.race([
    Promise.all([dns.resolve4(host).catch(() => []), dns.resolve6(host).catch(() => [])]).then(([a, b]) => {
      const all = [...a, ...b];
      return all.length > 0 && !all.some(isPrivateIp);
    }),
    new Promise(resolve => setTimeout(() => resolve(false), 2200)),
  ]);
  dnsCache.set(host, p);
  return p;
}
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Некорректный URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Разрешены только http/https ссылки');
  if (u.username || u.password) throw new Error('URL с логином/паролем не поддерживаются');
  if (!(await hostIsPublic(u.hostname))) throw new Error('Адрес сайта не является публичным');
  return u;
}
async function modules() {
  try {
    const [p, c] = await Promise.all([import('puppeteer-core'), import('@sparticuz/chromium')]);
    return { puppeteer: p.default || p, chromium: c.default || c };
  } catch (e) {
    throw new Error(`Не удалось загрузить Chromium-модули: ${e && e.message ? e.message : e}`);
  }
}
async function safeContinue(req) {
  try { if (!req.isInterceptResolutionHandled()) await req.continue(); } catch {}
}
async function safeAbort(req) {
  try { if (!req.isInterceptResolutionHandled()) await req.abort('blockedbyclient'); } catch {}
}

async function renderPage(rawUrl, width, options = {}) {
  let stage = 'проверка адреса';
  const safe = await assertPublicUrl(rawUrl);
  const { puppeteer, chromium } = await modules();
  chromium.setGraphicsMode = false;
  let browser;
  try {
    stage = 'запуск Chromium';
    browser = await puppeteer.launch({
      args: [...chromium.args, '--disable-dev-shm-usage', '--disable-background-timer-throttling'],
      executablePath: await chromium.executablePath(),
      headless: 'shell',
      defaultViewport: { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 },
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 });
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7' });

    stage = 'сетевые запросы';
    await page.setRequestInterception(true);
    page.on('request', async req => {
      try {
        const url = req.url(), type = req.resourceType();
        if (/^(data:|blob:|about:)/i.test(url)) return await safeContinue(req);
        if (!/^https?:/i.test(url) || ['media', 'websocket', 'eventsource'].includes(type)) return await safeAbort(req);
        const u = new URL(url);
        if (net.isIP(u.hostname) && isPrivateIp(u.hostname)) return await safeAbort(req);
        if (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.local')) return await safeAbort(req);
        return await safeContinue(req);
      } catch { return await safeAbort(req); }
    });

    stage = 'открытие страницы';
    await page.goto(safe.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    stage = 'первичная инициализация';
    await Promise.race([
      page.waitForNetworkIdle({ idleTime: 350, timeout: 3000 }).catch(() => {}),
      new Promise(r => setTimeout(r, 3000)),
    ]);
    await Promise.race([
      page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {}),
      new Promise(r => setTimeout(r, 2000)),
    ]);

    const prepare = async () => page.evaluate(() => {
      const hide = el => {
        if (!el || !el.style) return;
        el.style.setProperty('visibility', 'hidden', 'important');
        el.style.setProperty('opacity', '0', 'important');
        el.setAttribute('aria-hidden', 'true');
      };
      const show = el => {
        if (!el || !el.style) return;
        el.style.removeProperty('display');
        el.style.setProperty('visibility', 'visible', 'important');
        el.style.setProperty('opacity', '1', 'important');
        el.setAttribute('aria-hidden', 'false');
      };
      const fullTilda = raw => {
        if (!raw) return raw;
        let u;
        try { u = new URL(raw, location.href); } catch { return raw; }
        if (/^(thb|optim)\.tildacdn\.com$/i.test(u.hostname)) {
          u.hostname = 'static.tildacdn.com';
          u.pathname = u.pathname.replace(/\/-\/(?:resize|format|quality|scale_crop|cover)\/[^/]+/gi, '').replace(/\/+/g, '/');
        }
        return u.href;
      };
      const clipRectFor = root => {
        let result = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
        let hasClip = false;
        let n = root && root.parentElement;
        for (let i = 0; n && i < 10; i++, n = n.parentElement) {
          const cs = getComputedStyle(n), r = n.getBoundingClientRect();
          const ox = String(cs.overflowX || cs.overflow || '').toLowerCase();
          const oy = String(cs.overflowY || cs.overflow || '').toLowerCase();
          if (['hidden', 'clip'].includes(ox)) { hasClip = true; result.left = Math.max(result.left, r.left); result.right = Math.min(result.right, r.right); }
          if (['hidden', 'clip'].includes(oy)) { hasClip = true; result.top = Math.max(result.top, r.top); result.bottom = Math.min(result.bottom, r.bottom); }
        }
        if (!hasClip) {
          const fallback = root && root.parentElement ? root.parentElement.getBoundingClientRect() : root.getBoundingClientRect();
          result = { left: fallback.left, top: fallback.top, right: fallback.right, bottom: fallback.bottom };
        }
        return result;
      };
      const isVis = (el, clip) => {
        if (!el) return false;
        const cs = getComputedStyle(el), r = el.getBoundingClientRect();
        if (r.width <= .5 || r.height <= .5 || cs.display === 'none' || cs.visibility === 'hidden' || Number.parseFloat(cs.opacity || '1') <= .01) return false;
        if (!clip) return true;
        return r.right > clip.left + 1 && r.left < clip.right - 1 && r.bottom > clip.top + 1 && r.top < clip.bottom - 1;
      };
      const distinctVisible = (items, clip) => {
        const out = [];
        for (const el of items) {
          if (!isVis(el, clip)) continue;
          const r = el.getBoundingClientRect();
          const duplicate = out.some(x => {
            const q = x.getBoundingClientRect();
            const ix = Math.max(0, Math.min(r.right, q.right) - Math.max(r.left, q.left));
            const iy = Math.max(0, Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top));
            const inter = ix * iy, base = Math.max(1, Math.min(r.width * r.height, q.width * q.height));
            return inter / base > .82;
          });
          if (!duplicate) out.push(el);
          if (out.length >= 6) break;
        }
        return out;
      };
      const lockItems = (root, items, active) => {
        const frozenTransform = root.getAttribute('data-html2figma-transform') || getComputedStyle(root).transform;
        root.setAttribute('data-html2figma-transform', frozenTransform);
        let keep = items.filter(el => el.getAttribute('data-html2figma-keep') === '1');
        if (!keep.length) {
          const clip = clipRectFor(root);
          keep = distinctVisible(items, clip);
          if (!keep.length) {
            const activeItems = items.filter(el =>
              el.classList.contains(active) || el.classList.contains('slick-active') ||
              el.classList.contains('swiper-slide-visible') ||
              (el.classList.contains('owl-item') && el.classList.contains('active')) ||
              el.getAttribute('aria-hidden') === 'false'
            );
            keep = activeItems.filter(el => isVis(el, clip));
          }
          if (!keep.length) keep = [items[0]];
          keep = keep.slice(0, 6);
          const set = new Set(keep);
          items.forEach(el => {
            el.setAttribute(set.has(el) ? 'data-html2figma-keep' : 'data-html2figma-hide', '1');
            el.removeAttribute(set.has(el) ? 'data-html2figma-hide' : 'data-html2figma-keep');
          });
        }
        const set = new Set(keep);
        items.forEach(el => {
          el.classList.remove(active);
          if (set.has(el)) { el.classList.add(active); show(el); } else hide(el);
        });
        if (root && root.style) root.style.setProperty('transform', frozenTransform, 'important');
      };
      const defs = [
        ['.t-slds__items-wrapper', '.t-slds__item', 't-slds__item_active'],
        ['.t-carousel__inner', '.t-carousel__item', 't-carousel__item_active'],
        ['.swiper-wrapper', '.swiper-slide', 'swiper-slide-active'],
        ['.slick-track', '.slick-slide', 'slick-active'],
        ['.owl-stage', '.owl-item', 'active'],
      ];
      for (const [rootSel, itemSel, active] of defs) {
        for (const root of document.querySelectorAll(rootSel)) {
          let items = Array.from(root.querySelectorAll(':scope > ' + itemSel));
          if (!items.length) items = Array.from(root.querySelectorAll(itemSel));
          items = items.filter(el => !el.classList.contains('slick-cloned') && !el.classList.contains('swiper-slide-duplicate') && el.getAttribute('data-clone') !== 'true');
          if (items.length < 2) continue;
          lockItems(root, items, active);
        }
      }
      const groups = new Map();
      for (const el of document.querySelectorAll('[data-slide-index]')) {
        const p = el.parentElement;
        if (!p || p.matches('.t-slds__items-wrapper')) continue;
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p).push(el);
      }
      for (const [root, arrRaw] of groups.entries()) {
        if (arrRaw.length < 2) continue;
        const arr = arrRaw.slice().sort((a, b) => Number(a.getAttribute('data-slide-index') || 0) - Number(b.getAttribute('data-slide-index') || 0));
        lockItems(root, arr, 'html2figma-active');
      }
      document.querySelectorAll('.slick-cloned,.swiper-slide-duplicate,[data-clone="true"]').forEach(hide);
      for (const img of document.querySelectorAll('img')) {
        const full = img.getAttribute('data-original') || img.getAttribute('data-zoom-target') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-lazy');
        if (full) img.src = fullTilda(full);
        const ss = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
        if (ss) img.setAttribute('srcset', ss);
        try { img.loading = 'eager'; img.decoding = 'sync'; } catch {}
      }
      for (const src of document.querySelectorAll('source[data-srcset],source[data-lazy-srcset]')) {
        const v = src.getAttribute('data-srcset') || src.getAttribute('data-lazy-srcset');
        if (v) src.setAttribute('srcset', v);
      }
      for (const el of document.querySelectorAll('[data-original],[data-bg],[data-background-image],[data-lazy-bg]')) {
        if (el.tagName === 'IMG') continue;
        const raw = el.getAttribute('data-original') || el.getAttribute('data-bg') || el.getAttribute('data-background-image') || el.getAttribute('data-lazy-bg');
        if (!raw) continue;
        const u = fullTilda(raw), cs = getComputedStyle(el);
        if (!cs.backgroundImage || cs.backgroundImage === 'none' || /resize\/20x/i.test(cs.backgroundImage) || /thb\.tildacdn\.com/i.test(cs.backgroundImage)) {
          el.style.setProperty('background-image', `url("${String(u).replace(/"/g, '')}")`, 'important');
        }
      }
      try { for (const a of document.getAnimations ? document.getAnimations() : []) a.pause(); } catch {}
    });

    stage = 'фиксация первоначального состояния';
    await prepare();
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}[data-html2figma-hide="1"]{visibility:hidden!important;opacity:0!important}[data-html2figma-keep="1"]{visibility:visible!important;opacity:1!important}' }).catch(() => {});

    stage = 'lazy-load';
    await page.evaluate(async max => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const root = document.scrollingElement || document.documentElement;
      const total = Math.min(max, Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0, 1));
      for (let y = 0; y < total; y += 850) { window.scrollTo(0, y); await sleep(90); }
      window.scrollTo(0, 0); await sleep(350);
      const pending = Array.from(document.images || []).filter(i => !i.complete);
      await Promise.race([
        Promise.all(pending.slice(0, 700).map(i => new Promise(done => { i.addEventListener('load', done, { once: true }); i.addEventListener('error', done, { once: true }); }))),
        sleep(6500),
      ]);
      try { if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, sleep(2500)]); } catch {}
    }, MAX_HEIGHT);
    stage = 'повторная фиксация';
    await prepare();
    await new Promise(r => setTimeout(r, 250));

    stage = 'снятие геометрии';
    const snapshot = await page.evaluate(({ maxLayers, maxHeight, viewportWidth }) => {
      const win = window, doc = document, layers = [];
      let seq = 0, truncated = false, containerSeq = 0, imageCaptureSeq = 0, bgCaptureSeq = 0;
      const emitted = new Set(), semantic = new Map(), absBoxes = new Map(), imageCaptureIds = new Map(), bgCaptureIds = new Map();
      for (const img of Array.from(doc.images || [])) {
        const captureId = 'imgcap-' + imageCaptureSeq++;
        imageCaptureIds.set(img, captureId);
        try { img.setAttribute('data-html2figma-capture', captureId); } catch {}
      }
      const bgCaptureId = el => {
        if (!el || !(el instanceof HTMLElement)) return undefined;
        if (bgCaptureIds.has(el)) return bgCaptureIds.get(el);
        const id = 'bgcap-' + bgCaptureSeq++;
        bgCaptureIds.set(el, id);
        try { el.setAttribute('data-html2figma-bg-capture', id); } catch {}
        return id;
      };
      const num = (v, f = 0) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : f; };
      const round = v => Math.round(v * 100) / 100;
      const color = v => {
        const m = String(v || '').match(/rgba?\(([^)]+)\)/i);
        if (!m) return { r: 0, g: 0, b: 0, a: 0 };
        const p = m[1].split(',').map(x => Number.parseFloat(x.trim()));
        return { r: Math.max(0, Math.min(1, (p[0] || 0) / 255)), g: Math.max(0, Math.min(1, (p[1] || 0) / 255)), b: Math.max(0, Math.min(1, (p[2] || 0) / 255)), a: p.length > 3 && Number.isFinite(p[3]) ? Math.max(0, Math.min(1, p[3])) : 1 };
      };
      const rect = r => ({ x: round(r.left + win.scrollX), y: round(r.top + win.scrollY), width: round(r.width), height: round(r.height) });
      const name = (e, s = '') => ((e.tagName || 'node').toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList && e.classList.length ? '.' + Array.from(e.classList).slice(0, 2).join('.') : '') + s).slice(0, 100);
      const fullTilda = raw => {
        if (!raw) return raw;
        let u;
        try { u = new URL(raw, location.href); } catch { return raw; }
        if (/^(thb|optim)\.tildacdn\.com$/i.test(u.hostname)) { u.hostname = 'static.tildacdn.com'; u.pathname = u.pathname.replace(/\/-\/(?:resize|format|quality|scale_crop|cover)\/[^/]+/gi, '').replace(/\/+/g, '/'); }
        return u.href;
      };
      const urls = v => Array.from(new Set(Array.from(String(v || '').matchAll(/url\((?:"|')?([^"')]+)(?:"|')?\)/gi)).map(m => fullTilda(m[1]))));
      const radius = s => Math.max(num(s.borderTopLeftRadius), num(s.borderTopRightRadius), num(s.borderBottomLeftRadius), num(s.borderBottomRightRadius));
      const borderSides = s => ({ top: num(s.borderTopWidth), right: num(s.borderRightWidth), bottom: num(s.borderBottomWidth), left: num(s.borderLeftWidth) });
      const borderColor = s => color(num(s.borderTopWidth) ? s.borderTopColor : num(s.borderRightWidth) ? s.borderRightColor : num(s.borderBottomWidth) ? s.borderBottomColor : s.borderLeftColor);
      const borderWidth = s => Math.max(num(s.borderTopWidth), num(s.borderRightWidth), num(s.borderBottomWidth), num(s.borderLeftWidth));
      const shadow = v => {
        const raw = String(v || ''); if (!raw || raw === 'none' || raw.includes('inset')) return null;
        const cm = raw.match(/rgba?\([^)]*\)/i), ns = raw.replace(cm ? cm[0] : '', '').match(/-?[\d.]+px/g) || [];
        if (ns.length < 2) return null;
        return { color: color(cm ? cm[0] : 'rgba(0,0,0,.2)'), x: num(ns[0]), y: num(ns[1]), blur: num(ns[2]), spread: num(ns[3]) };
      };
      const gradient = v => {
        const raw = String(v || ''); if (!raw.includes('linear-gradient(')) return null;
        const cs = Array.from(raw.matchAll(/rgba?\([^)]*\)/gi)).map(m => color(m[0])); if (cs.length < 2) return null;
        const am = raw.match(/linear-gradient\(\s*(-?[\d.]+)deg/i);
        return { kind: 'linear', angle: am ? num(am[1], 180) : 180, stops: cs.slice(0, 8).map((c, i, a) => ({ position: i / Math.max(1, a.length - 1), color: c })) };
      };
      const fill = s => gradient(s.backgroundImage) || (color(s.backgroundColor).a > .01 ? { kind: 'solid', color: color(s.backgroundColor) } : undefined);
      const zIndex = s => { const z = Number.parseInt(s.zIndex, 10); return Number.isFinite(z) ? z : 0; };
      const createsContext = (e, s) => e === doc.documentElement || (s.position !== 'static' && s.zIndex !== 'auto') || num(s.opacity, 1) < .999 || s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none' || s.isolation === 'isolate' || s.mixBlendMode !== 'normal';
      const stackPath = e => {
        const chain = [];
        for (let n = e; n && n !== doc.body; n = n.parentElement) chain.unshift(n);
        const out = [];
        for (const n of chain) { const s = win.getComputedStyle(n); if (createsContext(n, s)) out.push(zIndex(s)); }
        return out.slice(-12);
      };
      const visible = (e, r, s) => {
        if (r.width <= .5 || r.height <= .5 || s.display === 'none' || s.visibility === 'hidden' || num(s.opacity, 1) <= .01) return false;
        let n = e;
        for (let i = 0; n && n !== doc.documentElement && i < 35; i++, n = n.parentElement) {
          if (n.hidden || n.getAttribute('aria-hidden') === 'true') return false;
          const cs = win.getComputedStyle(n), nr = n.getBoundingClientRect();
          if (cs.display === 'none' || cs.visibility === 'hidden' || num(cs.opacity, 1) <= .01) return false;
          if (cs.position === 'fixed' && (nr.right <= 0 || nr.left >= win.innerWidth || nr.bottom <= 0 || nr.top >= win.innerHeight)) return false;
          if (n !== e) {
            const ox = String(cs.overflowX || cs.overflow || '').toLowerCase(), oy = String(cs.overflowY || cs.overflow || '').toLowerCase();
            if (['hidden', 'clip'].includes(ox) && (r.right <= nr.left || r.left >= nr.right)) return false;
            if (['hidden', 'clip'].includes(oy) && (r.bottom <= nr.top || r.top >= nr.bottom)) return false;
          }
        }
        return true;
      };
      const clipFor = e => {
        let box = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
        for (let n = e.parentElement, i = 0; n && n !== doc.documentElement && i < 35; i++, n = n.parentElement) {
          const cs = win.getComputedStyle(n), r = n.getBoundingClientRect();
          const ox = String(cs.overflowX || cs.overflow || '').toLowerCase(), oy = String(cs.overflowY || cs.overflow || '').toLowerCase();
          if (['hidden', 'clip'].includes(ox)) { box.left = Math.max(box.left, r.left); box.right = Math.min(box.right, r.right); }
          if (['hidden', 'clip'].includes(oy)) { box.top = Math.max(box.top, r.top); box.bottom = Math.min(box.bottom, r.bottom); }
        }
        return box;
      };
      const dedupe = l => [l.kind, l.containerKey || '', l.parentContainerKey || '', round(l.absX ?? l.x), round(l.absY ?? l.y), round(l.width), round(l.height), l.text || '', l.url || '', l.fill && l.fill.kind === 'solid' ? JSON.stringify(l.fill.color) : ''].join('|');
      const add = l => {
        if (layers.length >= maxLayers) { truncated = true; return false; }
        if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.y) || l.width <= .5 || l.height <= .5) return true;
        const k = dedupe(l); if (emitted.has(k)) return true; emitted.add(k); l.z = seq++; layers.push(l); return true;
      };

      const sections = [], sectionEls = [], seen = new Set(), sectionMap = new Map();
      for (const e of doc.querySelectorAll('#allrecords > .t-rec,.t-rec[id],header,main > section,footer')) {
        if (seen.has(e)) continue; const s = win.getComputedStyle(e), r = e.getBoundingClientRect(); if (!visible(e, r, s)) continue; seen.add(e); sectionEls.push(e);
      }
      if (!sectionEls.length && doc.body) for (const e of doc.body.children) { const s = win.getComputedStyle(e), r = e.getBoundingClientRect(); if (visible(e, r, s)) sectionEls.push(e); }
      sectionEls.forEach((e, i) => {
        const r = e.getBoundingClientRect(), s = win.getComputedStyle(e), id = 'section-' + i; sectionMap.set(e, id);
        const ox = String(s.overflowX || s.overflow || '').toLowerCase(), oy = String(s.overflowY || s.overflow || '').toLowerCase();
        const secX = round(r.left + win.scrollX), secY = round(r.top + win.scrollY), secW = Math.max(1, round(r.width)), secH = Math.max(1, round(r.height));
        sections.push({ id, name: (e.id || (e.classList && e.classList[0]) || e.tagName.toLowerCase()).slice(0, 90), y: secY, height: secH, clipsContent: ['hidden', 'clip'].includes(ox) || ['hidden', 'clip'].includes(oy) });
        const sf = fill(s); if (sf) add({ kind: 'shape', name: 'section background', x: secX, y: secY, absX: secX, absY: secY, width: secW, height: secH, opacity: num(s.opacity, 1), fill: sf, sectionId: id, zIndex: -100000, stackPath: [-100000], paintPhase: -100 });
        const sbg = urls(s.backgroundImage), cap = sbg.length ? bgCaptureId(e) : undefined, sz = String(s.backgroundSize || 'cover'), pos = String(s.backgroundPosition || '50% 50%'), rep = String(s.backgroundRepeat || 'repeat');
        const prefer = sbg.length > 0 && (!/^(cover|contain)(\s*,\s*(cover|contain))*$/i.test(sz.trim()) || !/^(50%|center)\s+(50%|center)$/i.test(pos.trim()) || !/^no-repeat(?:\s*,\s*no-repeat)*$/i.test(rep.trim()));
        for (const u of sbg.slice(0, 3)) add({ kind: 'image', name: 'section background image', x: secX, y: secY, absX: secX, absY: secY, width: secW, height: secH, opacity: num(s.opacity, 1), url: u, sourceUrl: u, imageScaleMode: sz.includes('contain') ? 'FIT' : 'FILL', backgroundPosition: pos, backgroundSize: sz, sectionId: id, zIndex: -99999, stackPath: [-99999], paintPhase: -99, captureSafe: true, captureId: cap, captureMode: 'background', preferCapture: prefer });
      });
      const sectionFor = (e, r) => {
        const c = e.closest ? e.closest('.t-rec,header,section,footer') : null;
        if (c && sectionMap.has(c)) return sectionMap.get(c);
        const y = r.top + win.scrollY + Math.min(8, r.height / 2), hit = sections.find(s => y >= s.y - 2 && y <= s.y + s.height + 2);
        return hit ? hit.id : (sections[0] ? sections[0].id : undefined);
      };

      const candidates = Array.from(doc.querySelectorAll('body *')).filter(e => e instanceof HTMLElement || e instanceof SVGElement);
      const hasVisual = s => color(s.backgroundColor).a > .01 || urls(s.backgroundImage).length || !!gradient(s.backgroundImage) || borderWidth(s) > .1 || !!shadow(s.boxShadow);
      for (const e of candidates) {
        if (!(e instanceof HTMLElement)) continue;
        const s = win.getComputedStyle(e), r = e.getBoundingClientRect();
        if (!visible(e, r, s) || e === doc.body || e === doc.documentElement || e.matches('.t-rec,#allrecords') || sectionMap.has(e)) continue;
        const ox = String(s.overflowX || s.overflow || '').toLowerCase(), oy = String(s.overflowY || s.overflow || '').toLowerCase();
        const clipper = ['hidden', 'clip'].includes(ox) || ['hidden', 'clip'].includes(oy);
        const button = e.matches('button,[role="button"],.t-btn,.btn,.button,a[class*="btn"],a[class*="button"]'), visual = hasVisual(s), desc = e.querySelectorAll ? e.querySelectorAll('*').length : 0, content = (e.innerText || '').trim().length > 0 || !!e.querySelector('img,svg,picture'), modest = r.width <= 1200 && r.height <= 1200 && r.width >= 18 && r.height >= 14, structuralClip = clipper && r.width >= 2 && r.height >= 2 && r.width <= viewportWidth * 1.5 && r.height <= 5000;
        if (button || structuralClip || (s.display.includes('flex') && modest && content) || (visual && modest && content && desc <= 120)) { const key = 'container-' + (++containerSeq); semantic.set(e, key); absBoxes.set(key, rect(r)); }
      }
      const nearest = e => { let n = e.parentElement; for (let i = 0; n && n !== doc.body && i < 30; i++, n = n.parentElement) if (semantic.has(n)) return semantic.get(n); };
      const relative = (b, key) => { if (!key) return b; const p = absBoxes.get(key); return p ? { ...b, x: round(b.x - p.x), y: round(b.y - p.y) } : b; };

      const emitFieldText = (e, s, r, parentKey, sectionId, zi, sp) => {
        const tag = e.tagName;
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
        if (tag === 'INPUT' && /^(hidden|checkbox|radio|file|button|submit|reset|image|range|color)$/i.test(e.type || 'text')) return;
        let text = '', placeholder = false;
        if (tag === 'SELECT') text = e.options && e.selectedIndex >= 0 ? String(e.options[e.selectedIndex].text || '') : '';
        else {
          const val = String(e.value || ''), ph = String(e.getAttribute('placeholder') || '');
          const digits = val.replace(/\D/g, '');
          if (ph && (!val.trim() || (digits.length <= 1 && ph.length > val.length + 2))) { text = ph; placeholder = true; }
          else text = val || ph;
        }
        if (!text.trim()) return;
        const ps = placeholder ? win.getComputedStyle(e, '::placeholder') : s;
        const fs = num(s.fontSize, 16), lh = s.lineHeight === 'normal' ? fs * 1.2 : num(s.lineHeight, fs * 1.2), pl = num(s.paddingLeft) + num(s.borderLeftWidth), pr = num(s.paddingRight) + num(s.borderRightWidth), pt = num(s.paddingTop) + num(s.borderTopWidth), pb = num(s.paddingBottom) + num(s.borderBottomWidth);
        const x = r.left + win.scrollX + pl, w = Math.max(1, r.width - pl - pr), h = tag === 'TEXTAREA' ? Math.max(lh, r.height - pt - pb) : Math.min(Math.max(lh, 1), Math.max(1, r.height - pt - pb));
        const y = tag === 'TEXTAREA' ? r.top + win.scrollY + pt : r.top + win.scrollY + Math.max(pt, (r.height - h) / 2);
        const abs = { x: round(x), y: round(y), width: round(w), height: round(h) };
        add({ kind: 'text', name: name(e, placeholder ? ' — placeholder' : ' — значение поля'), ...relative(abs, parentKey), absX: abs.x, absY: abs.y, opacity: num(s.opacity, 1), fill: { kind: 'solid', color: color(ps.color || s.color) }, text, expectedLineCount: tag === 'TEXTAREA' ? Math.max(1, Math.round(h / Math.max(1, lh))) : 1, textRole: 'Body', fontSize: fs, fontWeight: num(s.fontWeight, 400), fontFamily: String(s.fontFamily || 'Inter').split(',')[0].trim().replace(/^['"]|['"]$/g, ''), fontStyle: String(s.fontStyle || 'normal'), lineHeight: lh, letterSpacing: s.letterSpacing === 'normal' ? 0 : num(s.letterSpacing), textAlign: String(s.textAlign || 'left').toUpperCase() === 'CENTER' ? 'CENTER' : String(s.textAlign || 'left').toUpperCase() === 'RIGHT' ? 'RIGHT' : 'LEFT', textSizing: 'FIXED', sectionId, parentContainerKey: parentKey, zIndex: zi, stackPath: sp, paintPhase: 3 });
      };

      for (const e of candidates) {
        if (truncated) break;
        const s = win.getComputedStyle(e), r = e.getBoundingClientRect();
        if (!visible(e, r, s) || (e instanceof SVGElement && e.tagName.toLowerCase() !== 'svg')) continue;
        const abs = rect(r), sectionId = sectionFor(e, r), parentKey = nearest(e), ownKey = semantic.get(e), base = relative(abs, parentKey), opacity = num(s.opacity, 1), rad = radius(s), zi = zIndex(s), sp = stackPath(e);
        if (ownKey) {
          const ox = String(s.overflowX || s.overflow || '').toLowerCase(), oy = String(s.overflowY || s.overflow || '').toLowerCase();
          add({ kind: 'container', name: name(e, e.matches('button,[role="button"],.t-btn,.btn,.button,a[class*="btn"],a[class*="button"]') ? ' — кнопка' : ' — контейнер'), ...base, absX: abs.x, absY: abs.y, opacity, fill: fill(s), strokeSides: borderSides(s), stroke: borderWidth(s) > .1 ? borderColor(s) : undefined, strokeWeight: borderWidth(s) || undefined, radius: rad || undefined, shadow: shadow(s.boxShadow) || undefined, sectionId, containerKey: ownKey, parentContainerKey: parentKey, layoutRole: s.display.includes('flex') && s.flexWrap === 'nowrap' && !s.flexDirection.endsWith('reverse') ? 'FLOW' : 'ABSOLUTE', layoutDirection: s.flexDirection.startsWith('row') ? 'HORIZONTAL' : 'VERTICAL', itemSpacing: num(s.flexDirection.startsWith('row') ? s.columnGap : s.rowGap), paddingTop: num(s.paddingTop), paddingRight: num(s.paddingRight), paddingBottom: num(s.paddingBottom), paddingLeft: num(s.paddingLeft), clipsContent: ['hidden', 'clip'].includes(ox) || ['hidden', 'clip'].includes(oy), zIndex: zi, stackPath: sp, paintPhase: 1 });
        }
        const childParent = ownKey || parentKey;
        if (e instanceof SVGElement && e.tagName.toLowerCase() === 'svg' && !e.closest('svg svg')) { add({ kind: 'svg', name: name(e), ...relative(abs, parentKey), absX: abs.x, absY: abs.y, opacity, svg: e.outerHTML.slice(0, 180000), sectionId, parentContainerKey: parentKey, zIndex: zi, stackPath: sp, paintPhase: 2 }); continue; }
        if (e.tagName === 'IMG') {
          const originalRaw = e.getAttribute('data-original') || e.getAttribute('data-zoom-target') || e.getAttribute('data-src') || e.getAttribute('data-lazy-src') || '', currentRaw = e.currentSrc || e.getAttribute('src') || '', raw = originalRaw || currentRaw;
          if (raw) { const u = fullTilda(raw), source = fullTilda(currentRaw || raw); add({ kind: 'image', name: name(e), ...relative(abs, parentKey), absX: abs.x, absY: abs.y, opacity, url: u, sourceUrl: source, radius: rad || undefined, imageScaleMode: String(s.objectFit || '').toLowerCase() === 'contain' ? 'FIT' : 'FILL', objectPosition: String(s.objectPosition || '50% 50%'), sectionId, parentContainerKey: parentKey, zIndex: zi, stackPath: sp, paintPhase: 2, captureSafe: true, captureId: imageCaptureIds.get(e) }); }
          continue;
        }
        const bgUrls = urls(s.backgroundImage), bgSize = String(s.backgroundSize || 'cover'), bgPos = String(s.backgroundPosition || '50% 50%'), bgRepeat = String(s.backgroundRepeat || 'repeat'), bgCap = bgUrls.length ? bgCaptureId(e) : undefined;
        const preferBgCapture = bgUrls.length > 0 && (!/^(cover|contain)(\s*,\s*(cover|contain))*$/i.test(bgSize.trim()) || !/^(50%|center)\s+(50%|center)$/i.test(bgPos.trim()) || !/^no-repeat(?:\s*,\s*no-repeat)*$/i.test(bgRepeat.trim()));
        for (const u of bgUrls.slice(0, 3)) add({ kind: 'image', name: name(e, ' — фон'), ...relative(abs, childParent), absX: abs.x, absY: abs.y, opacity, url: u, sourceUrl: u, radius: rad || undefined, imageScaleMode: bgSize.includes('contain') ? 'FIT' : 'FILL', backgroundPosition: bgPos, backgroundSize: bgSize, sectionId, parentContainerKey: childParent, zIndex: zi, stackPath: sp, paintPhase: 0, captureSafe: true, captureId: bgCap, captureMode: 'background', preferCapture: preferBgCapture });
        if (!ownKey && e !== doc.body && e !== doc.documentElement && !e.matches('#allrecords') && !sectionMap.has(e)) {
          const f = fill(s), bw = borderWidth(s), sh = shadow(s.boxShadow);
          if ((f || bw > .1 || sh) && !(bgUrls.length && f && f.kind !== 'linear')) add({ kind: 'shape', name: name(e, ' — плашка'), ...base, absX: abs.x, absY: abs.y, opacity, fill: f, strokeSides: borderSides(s), stroke: bw > .1 ? borderColor(s) : undefined, strokeWeight: bw || undefined, radius: rad || undefined, shadow: sh || undefined, sectionId, parentContainerKey: parentKey, zIndex: zi, stackPath: sp, paintPhase: 0 });
        }
        emitFieldText(e, s, r, childParent, sectionId, zi, sp);
      }

      const textOwner = node => {
        let e = node.parentElement;
        for (let i = 0; e && e !== doc.body && i < 20; i++, e = e.parentElement) {
          if (!(e instanceof HTMLElement)) continue;
          if (e.matches('input,textarea,select,option')) return null;
          const tag = e.tagName;
          if (tag === 'A') { const p = e.parentElement && e.parentElement.closest ? e.parentElement.closest('p,li,label,h1,h2,h3,h4,h5,h6,td,th,.tn-atom,.t-title,.t-name,.t-descr,.t-text') : null; if (!p) return e; }
          else if (/^(H[1-6]|P|LI|LABEL|BUTTON|TD|TH)$/.test(tag) || e.matches('.tn-atom,.t-title,.t-name,.t-descr,.t-text,.t-btn,[role="button"]')) return e;
          const cs = win.getComputedStyle(e); if (['block', 'flex', 'grid', 'list-item', 'table-cell'].includes(cs.display) && ((e.innerText || '').trim().length > 0)) return e;
        }
        return node.parentElement;
      };
      const textGroups = new Map(), walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT); let tn;
      while ((tn = walker.nextNode())) {
        if (!tn.nodeValue || !tn.nodeValue.trim()) continue;
        const pe = tn.parentElement;
        if (!pe || pe.closest('script,style,noscript,svg,input,textarea,select,option') || !visible(pe, pe.getBoundingClientRect(), win.getComputedStyle(pe))) continue;
        const owner = textOwner(tn); if (!owner) continue;
        const os = win.getComputedStyle(owner), or = owner.getBoundingClientRect(); if (!visible(owner, or, os)) continue;
        if (!textGroups.has(owner)) textGroups.set(owner, []); textGroups.get(owner).push(tn);
      }
      function visualText(owner, nodes) {
        const clip = clipFor(owner), words = []; let order = 0;
        for (const node of nodes) {
          const raw = node.nodeValue || '';
          for (const m of raw.matchAll(/\S+/g)) {
            const start = m.index || 0, end = start + m[0].length, rg = doc.createRange();
            try { rg.setStart(node, start); rg.setEnd(node, end); } catch { continue; }
            const r = rg.getBoundingClientRect(); if (r.width <= .2 || r.height <= .2) continue;
            const ix = Math.max(0, Math.min(r.right, clip.right) - Math.max(r.left, clip.left)), iy = Math.max(0, Math.min(r.bottom, clip.bottom) - Math.max(r.top, clip.top));
            if (ix * iy < r.width * r.height * .45) continue;
            words.push({ t: m[0], x: r.left + win.scrollX, y: r.top + win.scrollY, w: r.width, h: r.height, o: order++ });
          }
        }
        if (!words.length) return null;
        words.sort((a, b) => Math.abs(a.y - b.y) > 1.5 ? a.y - b.y : a.x - b.x || a.o - b.o);
        const lines = [];
        for (const w of words) { let line = lines.find(l => Math.abs(l.y - w.y) < Math.max(2, w.h * .35)); if (!line) { line = { y: w.y, items: [] }; lines.push(line); } line.items.push(w); }
        lines.sort((a, b) => a.y - b.y);
        const text = lines.map(l => l.items.sort((a, b) => a.x - b.x || a.o - b.o).map(x => x.t).join(' ')).join('\n');
        const minX = Math.min(...words.map(w => w.x)), minY = Math.min(...words.map(w => w.y)), maxX = Math.max(...words.map(w => w.x + w.w)), maxY = Math.max(...words.map(w => w.y + w.h));
        return { text, x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY), lineCount: lines.length };
      }
      for (const [owner, nodes] of textGroups.entries()) {
        if (truncated) break;
        const s = win.getComputedStyle(owner), r = owner.getBoundingClientRect(); if (!visible(owner, r, s)) continue;
        const v = visualText(owner, nodes); if (!v || !v.text) continue;
        const sectionId = sectionFor(owner, r), ownKey = semantic.get(owner), parentKey = ownKey || nearest(owner), scale = owner.offsetWidth > 0 ? r.width / owner.offsetWidth : 1, left = (num(s.paddingLeft) + num(s.borderLeftWidth)) * scale, right = (num(s.paddingRight) + num(s.borderRightWidth)) * scale;
        const contentWidth = Math.max(1, r.width - left - right);
        const abs = { x: round(r.left + win.scrollX + left), y: round(v.y), width: round(contentWidth), height: round(v.height) }, base = relative(abs, parentKey), fs = num(s.fontSize, 16) * scale, lh = s.lineHeight === 'normal' ? (v.lineCount > 1 ? Math.max(fs, round((v.height + fs * .25) / v.lineCount)) : fs * 1.2) : num(s.lineHeight, fs / scale * 1.2) * scale, ta = String(s.textAlign || 'left').toUpperCase(), sp = stackPath(owner);
        add({ kind: 'text', name: name(owner, ' — текст'), ...base, absX: abs.x, absY: abs.y, opacity: num(s.opacity, 1), fill: { kind: 'solid', color: color(s.color) }, text: v.text, expectedLineCount: v.lineCount, textRole: /^H[1-6]$/.test(owner.tagName) ? owner.tagName : (owner.matches('button,.t-btn,[role="button"]') ? 'Button' : 'Body'), fontSize: fs, fontWeight: num(s.fontWeight, 400), fontFamily: String(s.fontFamily || 'Inter').split(',')[0].trim().replace(/^['"]|['"]$/g, ''), fontStyle: String(s.fontStyle || 'normal'), lineHeight: lh, letterSpacing: s.letterSpacing === 'normal' ? 0 : num(s.letterSpacing) * scale, textAlign: ta === 'CENTER' ? 'CENTER' : ta === 'RIGHT' || ta === 'END' ? 'RIGHT' : ta === 'JUSTIFY' ? 'JUSTIFIED' : 'LEFT', textDecoration: String(s.textDecorationLine || 'none'), textSizing: 'FIXED', sectionId, parentContainerKey: parentKey, zIndex: zIndex(s), stackPath: sp, paintPhase: 2 });
      }
      const root = doc.scrollingElement || doc.documentElement;
      const height = Math.min(maxHeight, Math.max(root.scrollHeight, doc.body ? doc.body.scrollHeight : 0, 1));
      return { width: viewportWidth, height, sections, layers, truncated, rendererVersion: 17 };
    }, { maxLayers: MAX_LAYERS, maxHeight: MAX_HEIGHT, viewportWidth: width });

    if (!snapshot.layers.length) throw new Error('После рендера не найдено видимых слоёв');
    const captures = [];
    if (Array.isArray(options.captureClips) && options.captureClips.length) {
      stage = 'fallback-снимки изображений';
      for (const item of options.captureClips.slice(0, 48)) {
        const id = String(item && item.id != null ? item.id : ''), captureId = String(item && item.captureId || '');
        try {
          let buffer = null;
          if (/^[A-Za-z0-9_-]{1,80}$/.test(captureId)) {
            const captureMode = String(item && item.captureMode || 'element'), attr = captureMode === 'background' ? 'data-html2figma-bg-capture' : 'data-html2figma-capture', handle = await page.$(`[${attr}="${captureId}"]`);
            let cleanupId = '';
            if (handle) {
              if (captureMode === 'background') {
                cleanupId = '__html2figma_bg_' + captureId;
                await page.evaluate(({ captureId, cleanupId }) => { const st = document.createElement('style'); st.id = cleanupId; st.textContent = `[data-html2figma-bg-capture="${captureId}"]{color:transparent!important;text-shadow:none!important}[data-html2figma-bg-capture="${captureId}"]>*{visibility:hidden!important}[data-html2figma-bg-capture="${captureId}"]::before,[data-html2figma-bg-capture="${captureId}"]::after{visibility:hidden!important}`; document.head.appendChild(st); }, { captureId, cleanupId }).catch(() => {});
              }
              try { const box = await handle.boundingBox(); if (box && box.width > .5 && box.height > .5 && box.width <= 4096 && box.height <= 4096) buffer = await handle.screenshot({ type: 'png' }); }
              finally { if (cleanupId) await page.evaluate(id => { const x = document.getElementById(id); if (x) x.remove(); }, cleanupId).catch(() => {}); await handle.dispose().catch(() => {}); }
            }
          }
          if (!buffer) throw new Error('Элемент для снимка не найден или превышает допустимый размер');
          captures.push({ id, dataBase64: Buffer.from(buffer).toString('base64') });
        } catch (error) { captures.push({ id, error: error && error.message ? error.message : 'Не удалось снять fallback' }); }
      }
    }
    let referenceBuffer = null, qaReference = null;
    if (options.reference === true) {
      stage = 'контрольный снимок';
      const refHeight = Math.max(1, Math.min(snapshot.height, 30000));
      referenceBuffer = await page.screenshot({ type: 'webp', quality: 84, clip: { x: 0, y: 0, width, height: refHeight }, captureBeyondViewport: true });
    } else if (options.qaPreview === true) {
      // Capture immediately after extracting geometry, in the same browser run.
      // Visual QA is optional: screenshot failures must never discard the layout.
      const refHeight = Math.max(1, Math.min(snapshot.height, 18000));
      try {
        const screenshot = await page.screenshot({ type: 'webp', quality: 70, clip: { x: 0, y: 0, width, height: refHeight }, captureBeyondViewport: true });
        const sharp = require('sharp');
        const compact = await sharp(screenshot).resize({ width: 480, withoutEnlargement: true }).webp({ quality: 62, effort: 2 }).toBuffer();
        if (compact.length > 1200000) throw new Error('Снимок слишком велик для отчёта');
        qaReference = { mime: 'image/webp', dataBase64: compact.toString('base64'), width, height: snapshot.height, capturedHeight: refHeight };
      } catch (error) {
        qaReference = { error: error && error.message ? String(error.message).slice(0, 180) : 'Снимок недоступен' };
      }
    }
    return { finalUrl: page.url(), snapshot, captures, referenceBuffer, qaReference };
  } catch (e) {
    throw new Error(`${stage}: ${e && e.message ? e.message : e}`);
  } finally { if (browser) await browser.close().catch(() => {}); }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ ok: false, error: 'Разрешены только GET, POST и OPTIONS' });
  if (req.method === 'GET' && String(req.query.ping || '') === '1') return res.status(200).json({ ok: true, service: 'browser-renderer', version: 17, visualQa: true, clippedText: true, formText: true, stableInitialSliders: true, offscreenCarouselVisibility: true, stackPaths: true });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const raw = req.method === 'POST' ? (Array.isArray(body.url) ? body.url[0] : body.url) : (Array.isArray(req.query.url) ? req.query.url[0] : req.query.url);
  const rawWidth = req.method === 'POST' ? (Array.isArray(body.width) ? body.width[0] : body.width) : (Array.isArray(req.query.width) ? req.query.width[0] : req.query.width);
  const width = Math.max(320, Math.min(1920, Number(rawWidth) || 1440));
  if (!raw) return res.status(400).json({ ok: false, error: 'Не передан параметр url' });
  try {
    if (req.method === 'POST' && String(body.mode || '') === 'capture-clips') {
      const clips = Array.isArray(body.clips) ? body.clips : [];
      const { finalUrl, captures } = await renderPage(String(raw), width, { captureClips: clips });
      return res.status(200).json({ ok: true, finalUrl, captures });
    }
    const reference = req.method === 'GET' && String(req.query.reference || '') === '1';
    const qaPreview = req.method === 'GET' && String(req.query.qa || '') === '1' && !reference;
    const result = await renderPage(String(raw), width, { reference, qaPreview });
    if (reference && result.referenceBuffer) { res.setHeader('Content-Type', 'image/webp'); return res.status(200).send(result.referenceBuffer); }
    if (qaPreview && result.qaReference && result.qaReference.dataBase64 &&
        Buffer.byteLength(JSON.stringify(result.snapshot), 'utf8') + result.qaReference.dataBase64.length > 3500000) {
      result.qaReference = { error: 'Ответ слишком велик для передачи контрольного снимка' };
    }
    return res.status(200).json({ ok: true, mode: 'browser-snapshot-v17', finalUrl: result.finalUrl, snapshot: result.snapshot, ...(qaPreview ? { qaReference: result.qaReference } : {}), stats: { layers: result.snapshot.layers.length, sections: result.snapshot.sections.length, truncated: !!result.snapshot.truncated, imageLayers: result.snapshot.layers.filter(x => x.kind === 'image').length } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
