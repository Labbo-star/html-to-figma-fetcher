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
    Promise.all([
      dns.resolve4(host).catch(() => []),
      dns.resolve6(host).catch(() => []),
    ]).then(([a, b]) => {
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
  try {
    if (!req.isInterceptResolutionHandled()) await req.continue();
  } catch {}
}
async function safeAbort(req) {
  try {
    if (!req.isInterceptResolutionHandled()) await req.abort('blockedbyclient');
  } catch {}
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
        const url = req.url();
        const type = req.resourceType();
        if (/^(data:|blob:|about:)/i.test(url)) return await safeContinue(req);
        if (!/^https?:/i.test(url) || ['media', 'websocket', 'eventsource'].includes(type)) return await safeAbort(req);
        const u = new URL(url);
        if (net.isIP(u.hostname) && isPrivateIp(u.hostname)) return await safeAbort(req);
        if (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.local')) return await safeAbort(req);
        return await safeContinue(req);
      } catch {
        return await safeAbort(req);
      }
    });

    stage = 'открытие страницы';
    await page.goto(safe.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    const prepare = async () => page.evaluate(() => {
      const hide = el => {
        if (!el || !el.style) return;
        // Keep the slide's slot in the track: display:none moves the active slide.
        el.style.setProperty('visibility', 'hidden', 'important');
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
          u.pathname = u.pathname
            .replace(/\/-\/(?:resize|format|quality|scale_crop|cover)\/[^/]+/gi, '')
            .replace(/\/+/g, '/');
        }
        return u.href;
      };

      const clipRectFor = root => {
        let n = root && root.parentElement;
        for (let i = 0; n && i < 6; i++, n = n.parentElement) {
          const cs = getComputedStyle(n);
          const ox = String(cs.overflowX || cs.overflow || '').toLowerCase();
          const oy = String(cs.overflowY || cs.overflow || '').toLowerCase();
          if (['hidden', 'clip'].includes(ox) || ['hidden', 'clip'].includes(oy)) return n.getBoundingClientRect();
        }
        return (root && root.parentElement ? root.parentElement : root).getBoundingClientRect();
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
          const activeItems = items.filter(el =>
            el.classList.contains(active) ||
            el.classList.contains('slick-active') ||
            el.classList.contains('swiper-slide-visible') ||
            (el.classList.contains('owl-item') && el.classList.contains('active')) ||
            el.getAttribute('aria-hidden') === 'false'
          );
          const clip = clipRectFor(root);
          keep = activeItems.filter(el => isVis(el, clip));
          if (!keep.length) keep = distinctVisible(items, clip);
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
          if (set.has(el)) {
            el.classList.add(active);
            show(el);
          } else hide(el);
        });
        if (root && root.style) root.style.setProperty('transform', frozenTransform, 'important');
      };

      const defs = [
        ['.t-slds__items-wrapper', '.t-slds__item', 't-slds__item_active'],
        ['.t-slds__container', '.t-slds__item', 't-slds__item_active'],
        ['.t-carousel__inner', '.t-carousel__item', 't-carousel__item_active'],
        ['.swiper-wrapper', '.swiper-slide', 'swiper-slide-active'],
        ['.slick-track', '.slick-slide', 'slick-active'],
        ['.owl-stage', '.owl-item', 'active'],
      ];
      for (const [rootSel, itemSel, active] of defs) {
        for (const root of document.querySelectorAll(rootSel)) {
          let items = Array.from(root.querySelectorAll(':scope > ' + itemSel));
          if (!items.length) items = Array.from(root.querySelectorAll(itemSel));
          items = items.filter(el =>
            !el.classList.contains('slick-cloned') &&
            !el.classList.contains('swiper-slide-duplicate') &&
            el.getAttribute('data-clone') !== 'true'
          );
          if (items.length < 2) continue;
          if (items.every(el => el.hasAttribute('data-html2figma-keep') || el.hasAttribute('data-html2figma-hide')) && !root.hasAttribute('data-html2figma-transform')) continue;
          lockItems(root, items, active);
        }
      }
      const groups = new Map();
      for (const el of document.querySelectorAll('[data-slide-index]')) {
        const p = el.parentElement;
        if (!p) continue;
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p).push(el);
      }
      for (const [root, arrRaw] of groups.entries()) {
        if (arrRaw.length < 2) continue;
        const arr = arrRaw.slice().sort((a, b) => Number(a.getAttribute('data-slide-index') || 0) - Number(b.getAttribute('data-slide-index') || 0));
        if (!arr.some(el => el.hasAttribute('data-html2figma-keep') || el.hasAttribute('data-html2figma-hide'))) lockItems(root, arr, 'html2figma-active');
      }
      document.querySelectorAll('.slick-cloned,.swiper-slide-duplicate,[data-clone="true"]').forEach(hide);

      for (const img of document.querySelectorAll('img')) {
        const full = img.getAttribute('data-original') || img.getAttribute('data-zoom-target') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-lazy');
        if (full) img.src = fullTilda(full);
        const ss = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
        if (ss) img.setAttribute('srcset', ss);
        try { img.loading = 'eager'; } catch {}
        try { img.decoding = 'sync'; } catch {}
      }
      for (const src of document.querySelectorAll('source[data-srcset],source[data-lazy-srcset]')) {
        const v = src.getAttribute('data-srcset') || src.getAttribute('data-lazy-srcset');
        if (v) src.setAttribute('srcset', v);
      }
      for (const el of document.querySelectorAll('[data-original],[data-bg],[data-background-image],[data-lazy-bg]')) {
        if (el.tagName === 'IMG') continue;
        const raw = el.getAttribute('data-original') || el.getAttribute('data-bg') || el.getAttribute('data-background-image') || el.getAttribute('data-lazy-bg');
        if (!raw) continue;
        const u = fullTilda(raw);
        const cs = getComputedStyle(el);
        if (!cs.backgroundImage || cs.backgroundImage === 'none' || /resize\/20x/i.test(cs.backgroundImage) || /thb\.tildacdn\.com/i.test(cs.backgroundImage)) {
          el.style.setProperty('background-image', `url("${String(u).replace(/"/g, '')}")`, 'important');
        }
      }
      try { for (const a of document.getAnimations ? document.getAnimations() : []) a.pause(); } catch {}
    });

    stage = 'первое состояние';
    await prepare();
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}[data-html2figma-hide="1"]{visibility:hidden!important;opacity:0!important}' }).catch(() => {});

    stage = 'инициализация после фиксации';
    await Promise.race([
      page.waitForNetworkIdle({ idleTime: 300, timeout: 2500 }).catch(() => {}),
      new Promise(r => setTimeout(r, 2500)),
    ]);
    await Promise.race([
      page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {}),
      new Promise(r => setTimeout(r, 1800)),
    ]);
    await prepare();

    stage = 'lazy-load';
    await page.evaluate(async max => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const root = document.scrollingElement || document.documentElement;
      const total = Math.min(max, Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0, 1));
      for (let y = 0; y < total; y += 850) {
        window.scrollTo(0, y);
        await sleep(90);
      }
      window.scrollTo(0, 0);
      await sleep(350);
      const pending = Array.from(document.images || []).filter(i => !i.complete);
      await Promise.race([
        Promise.all(pending.slice(0, 600).map(i => new Promise(done => {
          i.addEventListener('load', done, { once: true });
          i.addEventListener('error', done, { once: true });
        }))),
        sleep(6000),
      ]);
      try {
        if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, sleep(2200)]);
      } catch {}
    }, MAX_HEIGHT);

    stage = 'повторная фиксация';
    await prepare();
    await new Promise(r => setTimeout(r, 250));

    stage = 'снятие геометрии';
    const snapshot = await page.evaluate(({ maxLayers, maxHeight, viewportWidth }) => {
      const win = window, doc = document, layers = [];
      let seq = 0, truncated = false, containerSeq = 0;
      const emitted = new Set(), semantic = new Map(), absBoxes = new Map(), imageCaptureIds = new Map(), bgCaptureIds = new Map();
      let imageCaptureSeq = 0, bgCaptureSeq = 0;
      for (const img of Array.from(doc.images || [])) {
        const captureId = 'imgcap-' + (imageCaptureSeq++);
        imageCaptureIds.set(img, captureId);
        try { img.setAttribute('data-html2figma-capture', captureId); } catch {}
      }
      const bgCaptureId = el => {
        if (!el || !(el instanceof HTMLElement)) return undefined;
        if (bgCaptureIds.has(el)) return bgCaptureIds.get(el);
        const id = 'bgcap-' + (bgCaptureSeq++);
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
        if (/^(thb|optim)\.tildacdn\.com$/i.test(u.hostname)) {
          u.hostname = 'static.tildacdn.com';
          u.pathname = u.pathname.replace(/\/-\/(?:resize|format|quality|scale_crop|cover)\/[^/]+/gi, '').replace(/\/+/g, '/');
        }
        return u.href;
      };
      const urls = v => Array.from(new Set(Array.from(String(v || '').matchAll(/url\((?:"|')?([^"')]+)(?:"|')?\)/gi)).map(m => fullTilda(m[1]))));
      const radius = s => Math.max(num(s.borderTopLeftRadius), num(s.borderTopRightRadius), num(s.borderBottomLeftRadius), num(s.borderBottomRightRadius));
      const borderSides = s => ({top: num(s.borderTopWidth), right: num(s.borderRightWidth), bottom: num(s.borderBottomWidth), left: num(s.borderLeftWidth)});
      const borderColor = s => color(num(s.borderTopWidth) ? s.borderTopColor : num(s.borderRightWidth) ? s.borderRightColor : num(s.borderBottomWidth) ? s.borderBottomColor : s.borderLeftColor);
      const borderWidth = s => Math.max(num(s.borderTopWidth), num(s.borderRightWidth), num(s.borderBottomWidth), num(s.borderLeftWidth));
      const shadow = v => {
        const raw = String(v || '');
        if (!raw || raw === 'none' || raw.includes('inset')) return null;
        const cm = raw.match(/rgba?\([^)]*\)/i), ns = raw.replace(cm ? cm[0] : '', '').match(/-?[\d.]+px/g) || [];
        if (ns.length < 2) return null;
        return { color: color(cm ? cm[0] : 'rgba(0,0,0,.2)'), x: num(ns[0]), y: num(ns[1]), blur: num(ns[2]), spread: num(ns[3]) };
      };
      const gradient = v => {
        const raw = String(v || '');
        if (!raw.includes('linear-gradient(')) return null;
        const cs = Array.from(raw.matchAll(/rgba?\([^)]*\)/gi)).map(m => color(m[0]));
        if (cs.length < 2) return null;
        const am = raw.match(/linear-gradient\(\s*(-?[\d.]+)deg/i);
        return { kind: 'linear', angle: am ? num(am[1], 180) : 180, stops: cs.slice(0, 8).map((c, i, a) => ({ position: i / Math.max(1, a.length - 1), color: c })) };
      };
      const fill = s => gradient(s.backgroundImage) || (color(s.backgroundColor).a > .01 ? { kind: 'solid', color: color(s.backgroundColor) } : undefined);
      const zIndex = s => { const z = Number.parseInt(s.zIndex, 10); return Number.isFinite(z) ? z : 0; };
      const visible = (e, r, s) => {
        if (r.width <= .5 || r.height <= .5 || s.display === 'none' || s.visibility === 'hidden' || num(s.opacity, 1) <= .01) return false;
        let n = e;
        for (let i = 0; n && n !== doc.documentElement && i < 30; i++, n = n.parentElement) {
          if (n.hidden || n.getAttribute('aria-hidden') === 'true') return false;
          const cs = win.getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden' || num(cs.opacity, 1) <= .01) return false;
          const nr = n.getBoundingClientRect();
          if (cs.position === 'fixed' && (nr.right <= 0 || nr.left >= win.innerWidth || nr.bottom <= 0 || nr.top >= win.innerHeight)) return false;
          if (n !== e) {
            const ox = String(cs.overflowX || cs.overflow || '').toLowerCase(), oy = String(cs.overflowY || cs.overflow || '').toLowerCase();
            if (['hidden', 'clip'].includes(ox) || ['hidden', 'clip'].includes(oy)) {
              const pr = n.getBoundingClientRect();
              if (['hidden', 'clip'].includes(ox) && (r.right <= pr.left || r.left >= pr.right)) return false;
              if (['hidden', 'clip'].includes(oy) && (r.bottom <= pr.top || r.top >= pr.bottom)) return false;
            }
          }
        }
        return true;
      };
      const dedupe = l => [l.kind, l.containerKey || '', l.parentContainerKey || '', round(l.absX ?? l.x), round(l.absY ?? l.y), round(l.width), round(l.height), l.text || '', l.url || '', l.fill && l.fill.kind === 'solid' ? JSON.stringify(l.fill.color) : ''].join('|');
      const add = l => {
        if (layers.length >= maxLayers) { truncated = true; return false; }
        if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.y) || l.width <= .5 || l.height <= .5) return true;
        const k = dedupe(l);
        if (emitted.has(k)) return true;
        emitted.add(k);
        l.z = seq++;
        layers.push(l);
        return true;
      };

      const sections = [], sectionEls = [], seen = new Set();
      for (const e of doc.querySelectorAll('#allrecords > .t-rec,.t-rec[id],header,main > section,footer')) {
        if (seen.has(e)) continue;
        const s = win.getComputedStyle(e), r = e.getBoundingClientRect();
        if (!visible(e, r, s)) continue;
        seen.add(e); sectionEls.push(e);
      }
      if (!sectionEls.length && doc.body) for (const e of doc.body.children) {
        const s = win.getComputedStyle(e), r = e.getBoundingClientRect();
        if (visible(e, r, s)) sectionEls.push(e);
      }
      const sectionMap = new Map();
      sectionEls.forEach((e, i) => {
        const r = e.getBoundingClientRect(), s = win.getComputedStyle(e), id = 'section-' + i;
        sectionMap.set(e, id);
        const ox = String(s.overflowX || s.overflow || '').toLowerCase(), oy = String(s.overflowY || s.overflow || '').toLowerCase();
        const secX = round(r.left + win.scrollX), secY = round(r.top + win.scrollY), secW = Math.max(1, round(r.width)), secH = Math.max(1, round(r.height));
        sections.push({ id, name: (e.id || (e.classList && e.classList[0]) || e.tagName.toLowerCase()).slice(0, 90), y: secY, height: secH, clipsContent: ['hidden', 'clip'].includes(ox) || ['hidden', 'clip'].includes(oy) });
        const sf = fill(s);
        if (sf) add({ kind: 'shape', name: 'section background', x: secX, y: secY, absX: secX, absY: secY, width: secW, height: secH, opacity: num(s.opacity, 1), fill: sf, sectionId: id, zIndex: -100000, paintPhase: -100 });
        const sbg = urls(s.backgroundImage), secBgCap = sbg.length ? bgCaptureId(e) : undefined;
        const secBgSize = String(s.backgroundSize || 'cover'), secBgPos = String(s.backgroundPosition || '50% 50%'), secBgRepeat = String(s.backgroundRepeat || 'repeat');
        const secPreferCapture = sbg.length > 0 && (!/^(cover|contain)(\s*,\s*(cover|contain))*$/i.test(secBgSize.trim()) || !/^(50%|center)\s+(50%|center)$/i.test(secBgPos.trim()) || !/^no-repeat(?:\s*,\s*no-repeat)*$/i.test(secBgRepeat.trim()));
        for (const u of sbg.slice(0, 3)) add({ kind: 'image', name: 'section background image', x: secX, y: secY, absX: secX, absY: secY, width: secW, height: secH, opacity: num(s.opacity, 1), url: u, sourceUrl: u, imageScaleMode: secBgSize.includes('contain') ? 'FIT' : 'FILL', backgroundPosition: secBgPos, backgroundSize: secBgSize, sectionId: id, zIndex: -99999, paintPhase: -99, captureSafe: true, captureId: secBgCap, captureMode: 'background', preferCapture: secPreferCapture });
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
        if (button || structuralClip || (s.display.includes('flex') && modest && content) || (visual && modest && content && desc <= 120)) {
          const key = 'container-' + (++containerSeq);
          semantic.set(e, key); absBoxes.set(key, rect(r));
        }
      }
      const nearest = e => {
        let n = e.parentElement;
        for (let i = 0; n && n !== doc.body && i < 30; i++, n = n.parentElement) if (semantic.has(n)) return semantic.get(n);
      };
      const relative = (b, key) => {
        if (!key) return b;
        const p = absBoxes.get(key);
        return p ? { ...b, x: round(b.x - p.x), y: round(b.y - p.y) } : b;
      };

      const textOwner = node => {
        let e = node.parentElement;
        for (let i = 0; e && e !== doc.body && i < 20; i++, e = e.parentElement) {
          if (!(e instanceof HTMLElement)) continue;
          const tag = e.tagName;
          if (tag === 'A') {
            const p = e.parentElement && e.parentElement.closest ? e.parentElement.closest('p,li,label,h1,h2,h3,h4,h5,h6,td,th,.tn-atom,.t-title,.t-name,.t-descr,.t-text') : null;
            if (!p) return e;
          } else if (/^(H[1-6]|P|LI|LABEL|BUTTON|TD|TH)$/.test(tag) || e.matches('.tn-atom,.t-title,.t-name,.t-descr,.t-text,.t-btn,[role="button"]')) return e;
          const cs = win.getComputedStyle(e);
          if (['block', 'flex', 'grid', 'list-item', 'table-cell'].includes(cs.display) && ((e.innerText || '').trim().length > 0)) return e;
        }
        return node.parentElement;
      };
      const textGroups = new Map();
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let tn;
      while ((tn = walker.nextNode())) {
        if (!tn.nodeValue || !tn.nodeValue.trim()) continue;
        const pe = tn.parentElement;
        if (!pe || pe.closest('script,style,noscript,svg') || !visible(pe, pe.getBoundingClientRect(), win.getComputedStyle(pe))) continue;
        const owner = textOwner(tn);
        if (!owner) continue;
        const os = win.getComputedStyle(owner), or = owner.getBoundingClientRect();
        if (!visible(owner, or, os)) continue;
        if (!textGroups.has(owner)) textGroups.set(owner, []);
        textGroups.get(owner).push(tn);
      }
      function visualText(owner, nodes) {
        const words = []; let order = 0;
        for (const node of nodes) {
          const raw = node.nodeValue || '';
          for (const m of raw.matchAll(/\S+/g)) {
            const start = m.index || 0, end = start + m[0].length;
            const rg = doc.createRange();
            try { rg.setStart(node, start); rg.setEnd(node, end); } catch { continue; }
            const r = rg.getBoundingClientRect();
            if (r.width > .2 && r.height > .2) words.push({ t: m[0], x: r.left + win.scrollX, y: r.top + win.scrollY, w: r.width, h: r.height, o: order++ });
          }
        }
        if (!words.length) return null;
        words.sort((a, b) => Math.abs(a.y - b.y) > 1.5 ? a.y - b.y : a.x - b.x || a.o - b.o);
        const lines = [];
        for (const w of words) {
          let line = lines.find(l => Math.abs(l.y - w.y) < Math.max(2, w.h * .35));
          if (!line) { line = { y: w.y, items: [] }; lines.push(line); }
          line.items.push(w);
        }
        lines.sort((a, b) => a.y - b.y);
        const text = lines.map(l => l.items.sort((a, b) => a.x - b.x || a.o - b.o).map(x => x.t).join(' ')).join('\n');
        const minX = Math.min(...words.map(w => w.x)), minY = Math.min(...words.map(w => w.y)), maxX = Math.max(...words.map(w => w.x + w.w)), maxY = Math.max(...words.map(w => w.y + w.h));
        return { text, x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY), lineCount: lines.length };
      }

      for (const e of candidates) {
        if (truncated) break;
        const s = win.getComputedStyle(e), r = e.getBoundingClientRect();
        if (!visible(e, r, s) || (e instanceof SVGElement && e.tagName.toLowerCase() !== 'svg')) continue;
        const abs = rect(r), sectionId = sectionFor(e, r), parentKey = nearest(e), ownKey = semantic.get(e), base = relative(abs, parentKey), opacity = num(s.opacity, 1), rad = radius(s), zi = zIndex(s);
        if (ownKey) {
          const ox = String(s.overflowX || s.overflow || '').toLowerCase(), oy = String(s.overflowY || s.overflow || '').toLowerCase();
          add({ kind: 'container', name: name(e, e.matches('button,[role="button"],.t-btn,.btn,.button,a[class*="btn"],a[class*="button"]') ? ' — кнопка' : ' — контейнер'), ...base, absX: abs.x, absY: abs.y, opacity, fill: fill(s), strokeSides: borderSides(s), stroke: borderWidth(s) > .1 ? borderColor(s) : undefined, strokeWeight: borderWidth(s) || undefined, radius: rad || undefined, shadow: shadow(s.boxShadow) || undefined, sectionId, containerKey: ownKey, parentContainerKey: parentKey, layoutRole: s.display.includes('flex') && s.flexWrap === 'nowrap' && !s.flexDirection.endsWith('reverse') ? 'FLOW' : 'ABSOLUTE', layoutDirection: s.flexDirection.startsWith('row') ? 'HORIZONTAL' : 'VERTICAL', itemSpacing: num(s.flexDirection.startsWith('row') ? s.columnGap : s.rowGap), paddingTop: num(s.paddingTop), paddingRight: num(s.paddingRight), paddingBottom: num(s.paddingBottom), paddingLeft: num(s.paddingLeft), clipsContent: ['hidden', 'clip'].includes(ox) || ['hidden', 'clip'].includes(oy), zIndex: zi, paintPhase: 1 });
        }
        const childParent = ownKey || parentKey;
        if (e instanceof SVGElement && e.tagName.toLowerCase() === 'svg' && !e.closest('svg svg')) {
          add({ kind: 'svg', name: name(e), ...relative(abs, parentKey), absX: abs.x, absY: abs.y, opacity, svg: e.outerHTML.slice(0, 180000), sectionId, parentContainerKey: parentKey, zIndex: zi, paintPhase: 2 });
          continue;
        }
        if (e.tagName === 'IMG') {
          const originalRaw = e.getAttribute('data-original') || e.getAttribute('data-zoom-target') || e.getAttribute('data-src') || e.getAttribute('data-lazy-src') || '';
          const currentRaw = e.currentSrc || e.getAttribute('src') || '';
          const raw = originalRaw || currentRaw;
          if (raw) {
            const u = fullTilda(raw), source = fullTilda(currentRaw || raw);
            add({ kind: 'image', name: name(e), ...relative(abs, parentKey), absX: abs.x, absY: abs.y, opacity, url: u, sourceUrl: source, radius: rad || undefined, imageScaleMode: String(s.objectFit || '').toLowerCase() === 'contain' ? 'FIT' : 'FILL', objectPosition: String(s.objectPosition || '50% 50%'), sectionId, parentContainerKey: parentKey, zIndex: zi, paintPhase: 2, captureSafe: true, captureId: imageCaptureIds.get(e) });
          }
          continue;
        }
        const bgUrls = urls(s.backgroundImage);
        const bgSize = String(s.backgroundSize || 'cover'), bgPos = String(s.backgroundPosition || '50% 50%'), bgRepeat = String(s.backgroundRepeat || 'repeat'), bgCap = bgUrls.length ? bgCaptureId(e) : undefined;
        const preferBgCapture = bgUrls.length > 0 && (!/^(cover|contain)(\s*,\s*(cover|contain))*$/i.test(bgSize.trim()) || !/^(50%|center)\s+(50%|center)$/i.test(bgPos.trim()) || !/^no-repeat(?:\s*,\s*no-repeat)*$/i.test(bgRepeat.trim()));
        for (const u of bgUrls.slice(0, 3)) {
          add({ kind: 'image', name: name(e, ' — фон'), ...relative(abs, childParent), absX: abs.x, absY: abs.y, opacity, url: u, sourceUrl: u, radius: rad || undefined, imageScaleMode: bgSize.includes('contain') ? 'FIT' : 'FILL', backgroundPosition: bgPos, backgroundSize: bgSize, sectionId, parentContainerKey: childParent, zIndex: zi, paintPhase: 0, captureSafe: true, captureId: bgCap, captureMode: 'background', preferCapture: preferBgCapture });
        }
        if (!ownKey && e !== doc.body && e !== doc.documentElement && !e.matches('#allrecords') && !sectionMap.has(e)) {
          const f = fill(s), bw = borderWidth(s), sh = shadow(s.boxShadow);
          if ((f || bw > .1 || sh) && !(bgUrls.length && f && f.kind !== 'linear')) add({ kind: 'shape', name: name(e, ' — плашка'), ...base, absX: abs.x, absY: abs.y, opacity, fill: f, strokeSides: borderSides(s), stroke: bw > .1 ? borderColor(s) : undefined, strokeWeight: bw || undefined, radius: rad || undefined, shadow: sh || undefined, sectionId, parentContainerKey: parentKey, zIndex: zi, paintPhase: 0 });
        }
      }

      for (const [owner, nodes] of textGroups.entries()) {
        if (truncated) break;
        const s = win.getComputedStyle(owner), r = owner.getBoundingClientRect();
        if (!visible(owner, r, s)) continue;
        const v = visualText(owner, nodes);
        if (!v || !v.text) continue;
        const sectionId = sectionFor(owner, r), ownKey = semantic.get(owner), parentKey = ownKey || nearest(owner), scale = owner.offsetWidth > 0 ? r.width / owner.offsetWidth : 1, left = (num(s.paddingLeft) + num(s.borderLeftWidth)) * scale, right = (num(s.paddingRight) + num(s.borderRightWidth)) * scale, abs = { x: round(r.left + win.scrollX + left), y: round(v.y), width: round(Math.max(v.width, r.width - left - right)), height: round(v.height) }, base = relative(abs, parentKey), fs = num(s.fontSize, 16) * scale, lh = s.lineHeight === 'normal' ? (v.lineCount > 1 ? Math.max(fs, round((v.height + fs * .25) / v.lineCount)) : fs * 1.2) : num(s.lineHeight, fs / scale * 1.2) * scale, ta = String(s.textAlign || 'left').toUpperCase();
        add({ kind: 'text', name: name(owner, ' — текст'), ...base, absX: abs.x, absY: abs.y, opacity: num(s.opacity, 1), fill: { kind: 'solid', color: color(s.color) }, text: v.text, expectedLineCount: v.lineCount, textRole: /^H[1-6]$/.test(owner.tagName) ? owner.tagName : (owner.matches('button,.t-btn,[role="button"]') ? 'Button' : 'Body'), fontSize: fs, fontWeight: num(s.fontWeight, 400), fontFamily: String(s.fontFamily || 'Inter').split(',')[0].trim().replace(/^['"]|['"]$/g, ''), fontStyle: String(s.fontStyle || 'normal'), lineHeight: lh, letterSpacing: s.letterSpacing === 'normal' ? 0 : num(s.letterSpacing) * scale, textAlign: ta === 'CENTER' ? 'CENTER' : ta === 'RIGHT' || ta === 'END' ? 'RIGHT' : ta === 'JUSTIFY' ? 'JUSTIFIED' : 'LEFT', textDecoration: String(s.textDecorationLine || 'none'), textSizing: 'FIXED', sectionId, parentContainerKey: parentKey, zIndex: zIndex(s), paintPhase: 2 });
      }

      const root = doc.scrollingElement || doc.documentElement;
      const height = Math.min(maxHeight, Math.max(root.scrollHeight, doc.body ? doc.body.scrollHeight : 0, 1));
      return { width: viewportWidth, height, sections, layers, truncated, rendererVersion: 15,
        sliderDiagnostics: Array.from(doc.querySelectorAll('.t-slds__items-wrapper')).slice(0,8).map(e => ({rect:rect(e.getBoundingClientRect()), transform:getComputedStyle(e).transform, items:Array.from(e.querySelectorAll('.t-slds__item')).map(i=>({rect:rect(i.getBoundingClientRect()), display:getComputedStyle(i).display, opacity:getComputedStyle(i).opacity, visibility:getComputedStyle(i).visibility, keep:i.getAttribute('data-html2figma-keep'), hide:i.getAttribute('data-html2figma-hide'), bg: i.querySelector('.tn-atom__slds-img')?.getAttribute('style')}))})) };
    }, { maxLayers: MAX_LAYERS, maxHeight: MAX_HEIGHT, viewportWidth: width });

    if (!snapshot.layers.length) throw new Error('После рендера не найдено видимых слоёв');

    const captures = [];
    if (Array.isArray(options.captureClips) && options.captureClips.length) {
      stage = 'fallback-снимки изображений';
      for (const item of options.captureClips.slice(0, 48)) {
        const id = String(item && item.id != null ? item.id : '');
        const captureId = String(item && item.captureId || '');
        try {
          let buffer = null;
          if (/^[A-Za-z0-9_-]{1,80}$/.test(captureId)) {
            const captureMode = String(item && item.captureMode || 'element');
            const attr = captureMode === 'background' ? 'data-html2figma-bg-capture' : 'data-html2figma-capture';
            const handle = await page.$(`[${attr}="${captureId}"]`);
            let cleanupId = '';
            if (handle) {
              if (captureMode === 'background') {
                cleanupId = '__html2figma_bg_' + captureId;
                await page.evaluate(({ captureId, cleanupId }) => {
                  const st = document.createElement('style');
                  st.id = cleanupId;
                  st.textContent = `[data-html2figma-bg-capture="${captureId}"]{color:transparent!important;text-shadow:none!important}[data-html2figma-bg-capture="${captureId}"]>*{visibility:hidden!important}[data-html2figma-bg-capture="${captureId}"]::before,[data-html2figma-bg-capture="${captureId}"]::after{visibility:hidden!important}`;
                  document.head.appendChild(st);
                }, { captureId, cleanupId }).catch(() => {});
              }
              try {
                const box = await handle.boundingBox();
                if (box && box.width > .5 && box.height > .5 && box.width <= 4096 && box.height <= 4096) buffer = await handle.screenshot({ type: 'png' });
              } finally {
                if (cleanupId) await page.evaluate(id => { const x = document.getElementById(id); if (x) x.remove(); }, cleanupId).catch(() => {});
                await handle.dispose().catch(() => {});
              }
            }
          }
          if (!buffer) throw new Error('Элемент для снимка не найден или превышает допустимый размер');
          captures.push({ id, dataBase64: Buffer.from(buffer).toString('base64') });
        } catch (error) {
          captures.push({ id, error: error && error.message ? error.message : 'Не удалось снять fallback' });
        }
      }
    }

    let referenceBuffer = null;
    if (options.reference === true) {
      stage = 'контрольный снимок';
      const refHeight = Math.max(1, Math.min(snapshot.height, 30000));
      referenceBuffer = await page.screenshot({ type: 'webp', quality: 84, clip: { x: 0, y: 0, width, height: refHeight }, captureBeyondViewport: true });
    }

    return { finalUrl: page.url(), snapshot, captures, referenceBuffer };
  } catch (e) {
    throw new Error(`${stage}: ${e && e.message ? e.message : e}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ ok: false, error: 'Разрешены только GET, POST и OPTIONS' });
  if (req.method === 'GET' && String(req.query.ping || '') === '1') return res.status(200).json({ ok: true, service: 'browser-renderer', version: 15, visualQa: true, clippingAncestors: true, backgroundCapture: true });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const raw = req.method === 'POST'
    ? (Array.isArray(body.url) ? body.url[0] : body.url)
    : (Array.isArray(req.query.url) ? req.query.url[0] : req.query.url);
  const rawWidth = req.method === 'POST'
    ? (Array.isArray(body.width) ? body.width[0] : body.width)
    : (Array.isArray(req.query.width) ? req.query.width[0] : req.query.width);
  const width = Math.max(320, Math.min(1920, Number(rawWidth) || 1440));
  if (!raw) return res.status(400).json({ ok: false, error: 'Не передан параметр url' });

  try {
    if (req.method === 'POST' && String(body.mode || '') === 'capture-clips') {
      const clips = Array.isArray(body.clips) ? body.clips : [];
      const { finalUrl, captures } = await renderPage(String(raw), width, { captureClips: clips });
      return res.status(200).json({ ok: true, mode: 'capture-clips-v1', finalUrl, captures });
    }

    const wantsReference = req.method === 'GET' && String(req.query.reference || '') === '1';
    const { finalUrl, snapshot, referenceBuffer } = await renderPage(String(raw), width, { reference: wantsReference });
    if (wantsReference) {
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('X-Final-Url', finalUrl);
      res.setHeader('X-Renderer-Version', '15');
      return res.status(200).send(referenceBuffer);
    }

    return res.status(200).json({
      ok: true,
      mode: 'browser-snapshot-v15-fidelity',
      finalUrl,
      snapshot,
      stats: {
        layers: snapshot.layers.length,
        sections: snapshot.sections.length,
        height: snapshot.height,
        truncated: snapshot.truncated,
        imageLayers: snapshot.layers.filter(x => x.kind === 'image').length,
        textLayers: snapshot.layers.filter(x => x.kind === 'text').length,
        visualQa: true,
      },
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e && e.message ? e.message : 'Не удалось отрендерить страницу' });
  }
};
