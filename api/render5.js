const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_LAYERS = 3600;
const MAX_HEIGHT = 60000;
const NAV_TIMEOUT = 15000;
const VIEWPORT_HEIGHT = 1100;
const MAX_CAPTURE_FALLBACKS = 40;
const MAX_EMBEDDED_CAPTURE_BYTES = 10 * 1024 * 1024;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}

function isPrivateV4(ip) {
  const p = String(ip || '').split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
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
  const type = net.isIP(ip);
  return type === 4 ? isPrivateV4(ip) : type === 6 ? isPrivateV6(ip) : true;
}

const dnsCache = new Map();
async function hostIsPublic(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (net.isIP(host)) return !isPrivateIp(host);
  if (dnsCache.has(host)) return dnsCache.get(host);
  const check = Promise.race([
    Promise.all([
      dns.resolve4(host).catch(() => []),
      dns.resolve6(host).catch(() => []),
    ]).then(([v4, v6]) => {
      const addresses = [...v4, ...v6];
      return addresses.length > 0 && !addresses.some(isPrivateIp);
    }),
    new Promise((resolve) => setTimeout(() => resolve(false), 2200)),
  ]);
  dnsCache.set(host, check);
  return check;
}
async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Некорректный URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Разрешены только http/https ссылки');
  if (url.username || url.password) throw new Error('URL с логином/паролем не поддерживаются');
  if (!(await hostIsPublic(url.hostname))) throw new Error('Адрес сайта не является публичным');
  return url;
}
async function loadBrowserModules() {
  try {
    const [pupMod, chrMod, sharpMod] = await Promise.all([
      import('puppeteer-core'),
      import('@sparticuz/chromium'),
      import('sharp'),
    ]);
    return {
      puppeteer: pupMod.default || pupMod,
      chromium: chrMod.default || chrMod,
      sharp: sharpMod.default || sharpMod,
    };
  } catch (error) {
    throw new Error(`Не удалось загрузить Chromium-модули: ${error && error.message ? error.message : error}`);
  }
}

async function normalizeCapture(sharp, buffer) {
  const pipeline = sharp(buffer, { failOn: 'none', limitInputPixels: 120_000_000 }).rotate();
  const meta = await pipeline.metadata();
  const w = Number(meta.width || 0);
  const h = Number(meta.height || 0);
  let out = pipeline;
  if (w > 4096 || h > 4096) {
    out = out.resize({
      width: Math.min(w, 4096),
      height: Math.min(h, 4096),
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  return out.png({ compressionLevel: 8, adaptiveFiltering: true }).toBuffer();
}

async function renderPage(rawUrl, width) {
  let stage = 'проверка адреса';
  const safeUrl = await assertPublicUrl(rawUrl);
  const { puppeteer, chromium, sharp } = await loadBrowserModules();
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
    page.on('request', async (request) => {
      try {
        const target = request.url();
        const type = request.resourceType();
        if (/^(data:|blob:|about:)/i.test(target)) return request.continue();
        if (!/^https?:/i.test(target)) return request.abort('blockedbyclient');
        if (type === 'media' || type === 'websocket' || type === 'eventsource') return request.abort('blockedbyclient');
        const parsed = new URL(target);
        if (!(await hostIsPublic(parsed.hostname))) return request.abort('blockedbyclient');
        return request.continue();
      } catch {
        try { return request.abort('blockedbyclient'); } catch {}
      }
    });

    stage = 'открытие страницы';
    await page.goto(safeUrl.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    stage = 'первичная инициализация';
    await Promise.race([
      page.waitForNetworkIdle({ idleTime: 250, timeout: 1800 }).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1800)),
    ]);
    await Promise.race([
      page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1200)),
    ]);

    const lockFirstState = async () => {
      await page.evaluate(() => {
        const hide = (el) => {
          if (!el || !el.style) return;
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('visibility', 'hidden', 'important');
          el.style.setProperty('opacity', '0', 'important');
          el.setAttribute('aria-hidden', 'true');
        };
        const show = (el) => {
          if (!el || !el.style) return;
          el.style.removeProperty('display');
          el.style.setProperty('visibility', 'visible', 'important');
          el.style.setProperty('opacity', '1', 'important');
          el.setAttribute('aria-hidden', 'false');
        };

        const defs = [
          { root: '.t-slds__items-wrapper', item: '.t-slds__item', active: 't-slds__item_active' },
          { root: '.t-slds__container', item: '.t-slds__item', active: 't-slds__item_active' },
          { root: '.t-carousel__inner', item: '.t-carousel__item', active: 't-carousel__item_active' },
          { root: '.swiper-wrapper', item: '.swiper-slide', active: 'swiper-slide-active' },
          { root: '.slick-track', item: '.slick-slide', active: 'slick-active' },
          { root: '.owl-stage', item: '.owl-item', active: 'active' },
        ];
        for (const def of defs) {
          for (const root of document.querySelectorAll(def.root)) {
            let items = Array.from(root.querySelectorAll(':scope > ' + def.item));
            if (!items.length) items = Array.from(root.querySelectorAll(def.item));
            items = items.filter((el) =>
              !el.classList.contains('slick-cloned') &&
              !el.classList.contains('swiper-slide-duplicate') &&
              el.getAttribute('data-clone') !== 'true'
            );
            if (items.length < 2) continue;
            items.forEach((item, i) => {
              item.classList.remove(def.active);
              if (i === 0) {
                item.classList.add(def.active);
                item.style.setProperty('transform', 'none', 'important');
                show(item);
              } else {
                hide(item);
              }
            });
            if (root.style) root.style.setProperty('transform', 'none', 'important');
          }
        }

        const indexed = Array.from(document.querySelectorAll('[data-slide-index]'));
        const groups = new Map();
        for (const item of indexed) {
          const parent = item.parentElement;
          if (!parent) continue;
          if (!groups.has(parent)) groups.set(parent, []);
          groups.get(parent).push(item);
        }
        for (const items of groups.values()) {
          if (items.length < 2) continue;
          items.sort((a, b) => Number(a.getAttribute('data-slide-index') || 0) - Number(b.getAttribute('data-slide-index') || 0));
          items.forEach((item, i) => i === 0 ? show(item) : hide(item));
        }

        document.querySelectorAll('.slick-cloned,.swiper-slide-duplicate,[data-clone="true"]').forEach(hide);

        for (const img of document.querySelectorAll('img')) {
          const full =
            img.getAttribute('data-original') ||
            img.getAttribute('data-zoom-target') ||
            img.getAttribute('data-src') ||
            img.getAttribute('data-lazy-src') ||
            img.getAttribute('data-lazy');
          if (full) {
            try { img.src = new URL(full, location.href).href; } catch { img.src = full; }
          }
          const srcset = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
          if (srcset) img.setAttribute('srcset', srcset);
          try { img.loading = 'eager'; } catch {}
          try { img.decoding = 'sync'; } catch {}
        }
        document.querySelectorAll('source[data-srcset],source[data-lazy-srcset]').forEach((el) => {
          const value = el.getAttribute('data-srcset') || el.getAttribute('data-lazy-srcset');
          if (value) el.setAttribute('srcset', value);
        });
        document.querySelectorAll('[data-original],[data-bg],[data-background-image],[data-lazy-bg]').forEach((el) => {
          if (el.tagName === 'IMG') return;
          const raw =
            el.getAttribute('data-original') ||
            el.getAttribute('data-bg') ||
            el.getAttribute('data-background-image') ||
            el.getAttribute('data-lazy-bg');
          if (!raw) return;
          const cs = getComputedStyle(el);
          if (!cs.backgroundImage || cs.backgroundImage === 'none' || /resize\/20x/i.test(cs.backgroundImage)) {
            let url = raw;
            try { url = new URL(raw, location.href).href; } catch {}
            el.style.setProperty('background-image', `url("${String(url).replace(/"/g, '')}")`, 'important');
          }
        });
      });
    };

    stage = 'фиксация первого состояния';
    await lockFirstState();
    await page.addStyleTag({
      content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}',
    }).catch(() => {});

    stage = 'lazy-load';
    await page.evaluate(async (maxHeight) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const root = document.scrollingElement || document.documentElement;
      const total = Math.min(maxHeight, Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0, 1));
      for (let y = 0; y < total; y += 900) {
        window.scrollTo(0, y);
        await sleep(70);
      }
      window.scrollTo(0, 0);
      await sleep(220);
      const pending = Array.from(document.images || []).filter((img) => !img.complete);
      await Promise.race([
        Promise.all(pending.slice(0, 500).map((img) => new Promise((done) => {
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
        }))),
        new Promise((done) => setTimeout(done, 4000)),
      ]);
      try { if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, sleep(1800)]); } catch {}
    }, MAX_HEIGHT);

    stage = 'повторная фиксация состояния';
    await lockFirstState();
    await page.evaluate(() => {
      try {
        for (const animation of document.getAnimations ? document.getAnimations() : []) {
          try { animation.pause(); } catch {}
        }
      } catch {}
      window.scrollTo(0, 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 180));

    stage = 'снятие иерархии';
    const snapshot = await page.evaluate(({ maxLayers, maxHeight, viewportWidth }) => {
      const win = window;
      const doc = document;
      const layers = [];
      let seq = 0;
      let truncated = false;
      let containerSeq = 0;
      let captureSeq = 0;
      const emitted = new Set();
      const semantic = new Map();
      const absoluteBox = new Map();
      const rasterRoots = new Map();

      const num = (v, f = 0) => {
        const n = Number.parseFloat(v);
        return Number.isFinite(n) ? n : f;
      };
      const round = (v) => Math.round(v * 100) / 100;
      const cleanName = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      const color = (v) => {
        const raw = String(v || '').trim();
        const m = raw.match(/rgba?\(([^)]+)\)/i);
        if (!m) return { r: 0, g: 0, b: 0, a: 0 };
        const p = m[1].split(',').map((x) => Number.parseFloat(x.trim()));
        return {
          r: Math.max(0, Math.min(1, (p[0] || 0) / 255)),
          g: Math.max(0, Math.min(1, (p[1] || 0) / 255)),
          b: Math.max(0, Math.min(1, (p[2] || 0) / 255)),
          a: p.length > 3 && Number.isFinite(p[3]) ? Math.max(0, Math.min(1, p[3])) : 1,
        };
      };
      const absRect = (r) => ({
        x: round(r.left + win.scrollX),
        y: round(r.top + win.scrollY),
        width: round(r.width),
        height: round(r.height),
      });
      const layerName = (e, suffix = '') => (
        (e.tagName || 'node').toLowerCase() +
        (e.id ? '#' + e.id : '') +
        (e.classList && e.classList.length ? '.' + Array.from(e.classList).slice(0, 2).join('.') : '') +
        suffix
      ).slice(0, 100);
      const rgbaKey = (c) => `${round(c.r)},${round(c.g)},${round(c.b)},${round(c.a)}`;
      const dedupeKey = (l) => [
        l.kind,
        l.containerKey || '',
        l.parentContainerKey || '',
        round(l.x), round(l.y), round(l.width), round(l.height),
        l.text || '',
        l.url || '',
        l.captureId || '',
        l.svg ? l.svg.slice(0, 100) : '',
        l.fill && l.fill.kind === 'solid' ? rgbaKey(l.fill.color) : '',
      ].join('|');
      const add = (layer) => {
        if (layers.length >= maxLayers) {
          truncated = true;
          return false;
        }
        if (!layer || !Number.isFinite(layer.x) || !Number.isFinite(layer.y) || layer.width <= .5 || layer.height <= .5) return true;
        if (!layer.parentContainerKey && (layer.absY > maxHeight + 500 || layer.absX > viewportWidth + 1200 || layer.absX + layer.width < -1200)) return true;
        const key = dedupeKey(layer);
        if (emitted.has(key)) return true;
        emitted.add(key);
        layer.z = seq++;
        layers.push(layer);
        return true;
      };
      const urlList = (v) => {
        const out = [];
        for (const m of String(v || '').matchAll(/url\((?:"|')?([^"')]+)(?:"|')?\)/gi)) {
          try { out.push(new URL(m[1], location.href).href); } catch { out.push(m[1]); }
        }
        return Array.from(new Set(out));
      };
      const gradient = (v) => {
        const raw = String(v || '');
        if (!raw.includes('linear-gradient(')) return null;
        const cs = Array.from(raw.matchAll(/rgba?\([^)]*\)/gi)).map((m) => color(m[0]));
        if (cs.length < 2) return null;
        const am = raw.match(/linear-gradient\(\s*(-?[\d.]+)deg/i);
        return {
          kind: 'linear',
          angle: am ? num(am[1], 180) : 180,
          stops: cs.slice(0, 8).map((c, i, a) => ({ position: i / Math.max(1, a.length - 1), color: c })),
        };
      };
      const shadow = (v) => {
        const raw = String(v || '');
        if (!raw || raw === 'none' || raw.includes('inset')) return null;
        const first = raw.split(/,(?![^(]*\))/)[0];
        const cm = first.match(/rgba?\([^)]*\)/i);
        const ns = first.replace(cm ? cm[0] : '', '').match(/-?[\d.]+px/g) || [];
        if (ns.length < 2) return null;
        return {
          color: color(cm ? cm[0] : 'rgba(0,0,0,.2)'),
          x: num(ns[0]),
          y: num(ns[1]),
          blur: num(ns[2]),
          spread: num(ns[3]),
        };
      };
      const radius = (s) => Math.max(
        num(s.borderTopLeftRadius),
        num(s.borderTopRightRadius),
        num(s.borderBottomLeftRadius),
        num(s.borderBottomRightRadius)
      );
      const align = (v) => {
        const s = String(v || '').toLowerCase();
        return s === 'center' ? 'CENTER' : (s === 'right' || s === 'end') ? 'RIGHT' : s === 'justify' ? 'JUSTIFIED' : 'LEFT';
      };
      const family = (v) => String(v || 'Inter').split(',')[0].trim().replace(/^['"]|['"]$/g, '') || 'Inter';
      const borderWidth = (s) => Math.max(num(s.borderTopWidth), num(s.borderRightWidth), num(s.borderBottomWidth), num(s.borderLeftWidth));
      const zIndex = (s) => {
        const n = Number.parseInt(String(s.zIndex || ''), 10);
        return Number.isFinite(n) ? n : 0;
      };
      const hasVisualBox = (s) =>
        color(s.backgroundColor).a > .01 ||
        !!gradient(s.backgroundImage) ||
        urlList(s.backgroundImage).length > 0 ||
        borderWidth(s) > .1 ||
        !!shadow(s.boxShadow);

      function hiddenByState(e) {
        let n = e;
        for (let i = 0; n && n !== doc.documentElement && i < 40; i += 1, n = n.parentElement) {
          if (n.hidden || n.getAttribute('aria-hidden') === 'true') return true;
          if (n.classList && (n.classList.contains('slick-cloned') || n.classList.contains('swiper-slide-duplicate'))) return true;
          const s = win.getComputedStyle(n);
          if (s.display === 'none' || s.visibility === 'hidden' || num(s.opacity, 1) <= .01) return true;
        }
        return false;
      }
      function clippedOut(e, r) {
        let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
        let n = e.parentElement;
        for (let i = 0; n && n !== doc.documentElement && i < 40; i += 1, n = n.parentElement) {
          const s = win.getComputedStyle(n);
          const ox = String(s.overflowX || s.overflow || '').toLowerCase();
          const oy = String(s.overflowY || s.overflow || '').toLowerCase();
          const clipX = ['hidden', 'clip', 'scroll', 'auto'].includes(ox);
          const clipY = ['hidden', 'clip', 'scroll', 'auto'].includes(oy);
          if (!clipX && !clipY) continue;
          const pr = n.getBoundingClientRect();
          if (clipX) { left = Math.max(left, pr.left); right = Math.min(right, pr.right); }
          if (clipY) { top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom); }
          if (right - left <= .5 || bottom - top <= .5) return true;
        }
        return false;
      }
      function visible(e, r, s) {
        return r.width > .5 &&
          r.height > .5 &&
          s.display !== 'none' &&
          s.visibility !== 'hidden' &&
          num(s.opacity, 1) > .01 &&
          !hiddenByState(e) &&
          !clippedOut(e, r);
      }

      const sectionEls = [];
      const seenSections = new Set();
      for (const e of Array.from(doc.querySelectorAll('#allrecords > .t-rec, .t-rec[id], header, main > section, footer'))) {
        if (seenSections.has(e)) continue;
        const s = win.getComputedStyle(e);
        const r = e.getBoundingClientRect();
        if (!visible(e, r, s)) continue;
        seenSections.add(e);
        sectionEls.push(e);
      }
      if (!sectionEls.length && doc.body) {
        for (const e of Array.from(doc.body.children)) {
          const s = win.getComputedStyle(e);
          const r = e.getBoundingClientRect();
          if (visible(e, r, s)) sectionEls.push(e);
        }
      }
      const sectionMap = new Map();
      const sections = sectionEls.map((e, i) => {
        const r = e.getBoundingClientRect();
        const id = 'section-' + i;
        sectionMap.set(e, id);
        return {
          id,
          name: cleanName(e.id || (e.classList && e.classList[0]) || e.tagName.toLowerCase()).slice(0, 90),
          y: round(r.top + win.scrollY),
          height: Math.max(1, round(r.height)),
        };
      });
      const sectionFor = (e, r) => {
        const closest = e.closest ? e.closest('.t-rec,header,section,footer') : null;
        if (closest && sectionMap.has(closest)) return sectionMap.get(closest);
        const y = r.top + win.scrollY + Math.min(8, r.height / 2);
        const hit = sections.find((s) => y >= s.y - 2 && y <= s.y + s.height + 2);
        return hit ? hit.id : (sections[0] ? sections[0].id : undefined);
      };

      const candidates = Array.from(doc.querySelectorAll('body *')).filter((e) => e instanceof HTMLElement || e instanceof SVGElement);

      function transformIsComplex(s) {
        const t = String(s.transform || 'none');
        if (!t || t === 'none') return false;
        const m2 = t.match(/^matrix\(([^)]+)\)$/);
        if (m2) {
          const p = m2[1].split(',').map(Number);
          return Math.abs(p[1] || 0) > .001 || Math.abs(p[2] || 0) > .001;
        }
        return /matrix3d|rotate|skew/i.test(t);
      }
      function shouldRasterize(e, s, r) {
        if (r.width > 2200 || r.height > 2200) return false;
        if (e.tagName === 'CANVAS' || e.tagName === 'IFRAME' || e.tagName === 'OBJECT' || e.tagName === 'EMBED') return true;
        if (String(s.filter || 'none') !== 'none') return true;
        if (String(s.backdropFilter || 'none') !== 'none') return true;
        if (String(s.clipPath || 'none') !== 'none') return true;
        if (String(s.maskImage || s.webkitMaskImage || 'none') !== 'none') return true;
        if (transformIsComplex(s)) return true;
        return false;
      }
      for (const e of candidates) {
        if (!(e instanceof HTMLElement)) continue;
        const s = win.getComputedStyle(e);
        const r = e.getBoundingClientRect();
        if (!visible(e, r, s)) continue;
        if (!shouldRasterize(e, s, r)) continue;
        const id = 'capture-' + (++captureSeq);
        e.setAttribute('data-figma-capture-id', id);
        rasterRoots.set(e, id);
      }
      function rasterAncestor(e) {
        let n = e.parentElement;
        for (let i = 0; n && n !== doc.body && i < 40; i += 1, n = n.parentElement) {
          if (rasterRoots.has(n)) return rasterRoots.get(n);
        }
        return undefined;
      }

      for (const e of candidates) {
        if (!(e instanceof HTMLElement)) continue;
        if (rasterRoots.has(e) || rasterAncestor(e)) continue;
        const s = win.getComputedStyle(e);
        const r = e.getBoundingClientRect();
        if (!visible(e, r, s)) continue;
        if (e === doc.body || e === doc.documentElement || e.matches('.t-rec,#allrecords')) continue;

        const buttonLike = e.matches('button,[role="button"],.t-btn,.btn,.button,a[class*="btn"],a[class*="button"]');
        const visual = hasVisualBox(s);
        const descendantElements = e.querySelectorAll ? e.querySelectorAll('*').length : 0;
        const directChildren = e.children ? e.children.length : 0;
        const hasContent =
          cleanName(e.textContent || '').length > 0 ||
          !!e.querySelector('img,svg,picture,canvas');
        const modest = r.width <= 1200 && r.height <= 1200 && r.width >= 18 && r.height >= 14;
        const semanticName = `${e.id || ''} ${e.className || ''}`.toLowerCase();
        const semanticHint = /(card|tile|item|box|panel|feature|service|price|tariff|btn|button)/.test(semanticName);
        const cardLike = visual && modest && hasContent && descendantElements <= 120 && (directChildren > 1 || semanticHint);

        if (buttonLike || cardLike) {
          const key = 'container-' + (++containerSeq);
          semantic.set(e, key);
          absoluteBox.set(key, absRect(r));
        }
      }

      const nearestContainer = (e) => {
        let n = e.parentElement;
        for (let i = 0; n && n !== doc.body && i < 40; i += 1, n = n.parentElement) {
          if (semantic.has(n)) return semantic.get(n);
        }
        return undefined;
      };
      const positioned = (abs, parentKey) => {
        const local = { ...abs };
        if (parentKey) {
          const p = absoluteBox.get(parentKey);
          if (p) {
            local.x = round(abs.x - p.x);
            local.y = round(abs.y - p.y);
          }
        }
        return { ...local, absX: abs.x, absY: abs.y };
      };

      function resolveUrl(raw) {
        if (!raw) return '';
        if (/^data:/i.test(raw) || /^blob:/i.test(raw)) return raw;
        try { return new URL(raw, location.href).href; } catch { return raw; }
      }
      function chosenImgUrl(img) {
        const choices = [
          img.getAttribute('data-original'),
          img.getAttribute('data-zoom-target'),
          img.getAttribute('data-src'),
          img.getAttribute('data-lazy-src'),
          img.getAttribute('data-lazy'),
          img.currentSrc,
          img.getAttribute('src'),
        ].filter(Boolean);
        return choices.length ? resolveUrl(choices[0]) : '';
      }
      function sourceImageData(url) {
        const m = String(url || '').match(/^data:image\/[^;]+;base64,(.+)$/i);
        return m ? m[1] : undefined;
      }
      function lineHeightForTextNode(node, s) {
        if (s.lineHeight !== 'normal') return num(s.lineHeight, num(s.fontSize, 16) * 1.2);
        try {
          const range = doc.createRange();
          range.selectNodeContents(node);
          const rects = Array.from(range.getClientRects()).filter((r) => r.width > .5 && r.height > .5);
          const tops = [];
          for (const r of rects) {
            if (!tops.some((t) => Math.abs(t - r.top) < 1)) tops.push(r.top);
          }
          tops.sort((a, b) => a - b);
          if (tops.length >= 2) {
            const diffs = [];
            for (let i = 1; i < tops.length; i += 1) diffs.push(tops[i] - tops[i - 1]);
            diffs.sort((a, b) => a - b);
            const mid = diffs[Math.floor(diffs.length / 2)];
            if (mid > 2) return mid;
          }
        } catch {}
        return num(s.fontSize, 16) * 1.2;
      }
      function visualText(node) {
        const raw = String(node.nodeValue || '').replace(/\r/g, '');
        if (!raw.trim()) return '';
        if (raw.length > 12000) return raw.trim().slice(0, 12000);
        const words = Array.from(raw.matchAll(/\S+/g));
        if (!words.length) return '';
        const lines = [];
        let currentTop = null;
        let line = [];
        const range = doc.createRange();
        for (const m of words) {
          const start = m.index || 0;
          const end = start + m[0].length;
          try {
            range.setStart(node, start);
            range.setEnd(node, end);
            const r = range.getBoundingClientRect();
            if (r.width <= .1 || r.height <= .1) continue;
            if (currentTop == null || Math.abs(r.top - currentTop) <= 1.5) {
              line.push(m[0]);
              if (currentTop == null) currentTop = r.top;
            } else {
              if (line.length) lines.push(line.join(' '));
              line = [m[0]];
              currentTop = r.top;
            }
          } catch {}
        }
        if (line.length) lines.push(line.join(' '));
        return lines.length ? lines.join('\n') : raw.trim();
      }

      function pseudoBox(e, ps) {
        const er = e.getBoundingClientRect();
        let w = num(ps.width, NaN);
        let h = num(ps.height, NaN);
        const l = num(ps.left, NaN);
        const r = num(ps.right, NaN);
        const t = num(ps.top, NaN);
        const b = num(ps.bottom, NaN);
        if (!Number.isFinite(w) && Number.isFinite(l) && Number.isFinite(r)) w = Math.max(0, er.width - l - r);
        if (!Number.isFinite(h) && Number.isFinite(t) && Number.isFinite(b)) h = Math.max(0, er.height - t - b);
        if (!Number.isFinite(w)) w = er.width;
        if (!Number.isFinite(h)) h = er.height;
        const left = er.left + (Number.isFinite(l) ? l : 0);
        const top = er.top + (Number.isFinite(t) ? t : 0);
        return { x: round(left + win.scrollX), y: round(top + win.scrollY), width: round(w), height: round(h) };
      }
      function capturePseudo(e, which, sectionId, parentContainerKey, phase) {
        const ps = win.getComputedStyle(e, which);
        if (!ps || ps.display === 'none' || ps.visibility === 'hidden' || num(ps.opacity, 1) <= .01) return;
        const content = String(ps.content || '').replace(/^['"]|['"]$/g, '').trim();
        const abs = pseudoBox(e, ps);
        if (abs.width <= .5 || abs.height <= .5) return;
        const base = positioned(abs, parentContainerKey);
        const urls = urlList(ps.backgroundImage);
        const bg = color(ps.backgroundColor);
        const gr = gradient(ps.backgroundImage);
        const bw = borderWidth(ps);
        const sh = shadow(ps.boxShadow);
        const zi = zIndex(ps);
        if (bg.a > .01 || gr || bw > .1 || sh) {
          add({
            kind: 'shape',
            name: layerName(e, ` ${which} — плашка`),
            ...base,
            opacity: num(ps.opacity, 1),
            fill: gr || (bg.a > .01 ? { kind: 'solid', color: bg } : undefined),
            stroke: bw > .1 ? color(ps.borderTopColor) : undefined,
            strokeWeight: bw || undefined,
            radius: radius(ps) || undefined,
            shadow: sh || undefined,
            sectionId,
            parentContainerKey,
            zIndex: zi,
            paintPhase: phase,
          });
        }
        for (const url of urls.slice(0, 2)) {
          const data = sourceImageData(url);
          add({
            kind: 'image',
            name: layerName(e, ` ${which} — изображение`),
            ...base,
            opacity: num(ps.opacity, 1),
            url: data ? undefined : url,
            imageDataBase64: data,
            radius: radius(ps),
            imageScaleMode: String(ps.backgroundSize || '').includes('contain') ? 'FIT' : 'FILL',
            sectionId,
            parentContainerKey,
            zIndex: zi,
            paintPhase: phase,
          });
        }
        if (content && content !== 'none' && content !== 'normal' && !/^url\(/i.test(content)) {
          add({
            kind: 'text',
            name: layerName(e, ` ${which} — текст`),
            ...base,
            opacity: num(ps.opacity, 1),
            fill: { kind: 'solid', color: color(ps.color) },
            text: content,
            textRole: 'Body',
            fontSize: num(ps.fontSize, 16),
            fontWeight: num(ps.fontWeight, 400),
            fontFamily: family(ps.fontFamily),
            fontStyle: String(ps.fontStyle || 'normal'),
            lineHeight: ps.lineHeight === 'normal' ? num(ps.fontSize, 16) * 1.2 : num(ps.lineHeight, num(ps.fontSize, 16) * 1.2),
            letterSpacing: ps.letterSpacing === 'normal' ? 0 : num(ps.letterSpacing),
            textAlign: align(ps.textAlign),
            textDecoration: String(ps.textDecorationLine || ''),
            textSizing: 'FIXED',
            sectionId,
            parentContainerKey,
            zIndex: zi,
            paintPhase: phase,
          });
        }
      }

      for (const e of candidates) {
        if (truncated) break;
        const s = win.getComputedStyle(e);
        const r = e.getBoundingClientRect();
        if (!visible(e, r, s)) continue;

        const parentRaster = rasterAncestor(e);
        if (parentRaster) continue;

        const abs = absRect(r);
        const sectionId = sectionFor(e, r);
        const opacity = num(s.opacity, 1);
        const rad = radius(s);
        const zi = zIndex(s);
        const ownContainerKey = semantic.get(e);
        const parentContainerKey = nearestContainer(e);
        const base = positioned(abs, parentContainerKey);

        if (rasterRoots.has(e)) {
          add({
            kind: 'image',
            name: layerName(e, ' — браузерный растр'),
            ...base,
            opacity,
            captureId: rasterRoots.get(e),
            sectionId,
            parentContainerKey,
            zIndex: zi,
            paintPhase: 1,
            imageScaleMode: 'FILL',
          });
          continue;
        }

        if (ownContainerKey) {
          const bg = color(s.backgroundColor);
          const bw = borderWidth(s);
          const sh = shadow(s.boxShadow);
          const gr = gradient(s.backgroundImage);
          add({
            kind: 'container',
            name: layerName(e, e.matches('button,[role="button"],.t-btn,.btn,.button,a[class*="btn"],a[class*="button"]') ? ' — кнопка' : ' — контейнер'),
            ...base,
            opacity,
            fill: gr || (bg.a > .01 ? { kind: 'solid', color: bg } : undefined),
            stroke: bw > .1 ? color(s.borderTopColor) : undefined,
            strokeWeight: bw || undefined,
            radius: rad || undefined,
            shadow: sh || undefined,
            sectionId,
            containerKey: ownContainerKey,
            parentContainerKey,
            layoutRole: 'ABSOLUTE',
            clipsContent: ['hidden', 'clip'].includes(String(s.overflow || '').toLowerCase()) ||
              ['hidden', 'clip'].includes(String(s.overflowX || '').toLowerCase()) ||
              ['hidden', 'clip'].includes(String(s.overflowY || '').toLowerCase()),
            zIndex: zi,
            paintPhase: 1,
          });

          const urls = urlList(s.backgroundImage);
          for (let i = urls.length - 1; i >= 0; i -= 1) {
            const url = urls[i];
            const data = sourceImageData(url);
            add({
              kind: 'image',
              name: layerName(e, ` — фон${urls.length > 1 ? ' ' + (i + 1) : ''}`),
              ...positioned(abs, ownContainerKey),
              opacity: 1,
              url: data ? undefined : url,
              imageDataBase64: data,
              radius: rad,
              imageScaleMode: String(s.backgroundSize || '').includes('contain') ? 'FIT' : 'FILL',
              backgroundPosition: String(s.backgroundPosition || '50% 50%'),
              backgroundSize: String(s.backgroundSize || 'auto'),
              sectionId,
              parentContainerKey: ownContainerKey,
              zIndex: zi,
              paintPhase: 0,
            });
          }
        } else if (e instanceof SVGElement && e.tagName.toLowerCase() === 'svg') {
          add({
            kind: 'svg',
            name: layerName(e),
            ...base,
            opacity,
            svg: e.outerHTML.slice(0, 220000),
            sectionId,
            parentContainerKey,
            zIndex: zi,
            paintPhase: 1,
          });
          continue;
        } else if (e.tagName === 'IMG') {
          const url = chosenImgUrl(e);
          if (url) {
            const data = sourceImageData(url);
            if (/^blob:/i.test(url)) {
              const id = 'capture-' + (++captureSeq);
              e.setAttribute('data-figma-capture-id', id);
              add({
                kind: 'image',
                name: layerName(e),
                ...base,
                opacity,
                captureId: id,
                radius: rad,
                imageScaleMode: 'FILL',
                sectionId,
                parentContainerKey,
                zIndex: zi,
                paintPhase: 1,
              });
            } else {
              add({
                kind: 'image',
                name: layerName(e),
                ...base,
                opacity,
                url: data ? undefined : url,
                sourceUrl: data ? undefined : url,
                imageDataBase64: data,
                radius: rad,
                imageScaleMode: String(s.objectFit || '').toLowerCase() === 'contain' ? 'FIT' : 'FILL',
                objectPosition: String(s.objectPosition || '50% 50%'),
                sectionId,
                parentContainerKey,
                zIndex: zi,
                paintPhase: 1,
              });
            }
          }
          continue;
        } else {
          const urls = urlList(s.backgroundImage);
          for (let i = urls.length - 1; i >= 0; i -= 1) {
            const url = urls[i];
            const data = sourceImageData(url);
            add({
              kind: 'image',
              name: layerName(e, ` — фон${urls.length > 1 ? ' ' + (i + 1) : ''}`),
              ...base,
              opacity,
              url: data ? undefined : url,
              sourceUrl: data ? undefined : url,
              imageDataBase64: data,
              radius: rad,
              imageScaleMode: String(s.backgroundSize || '').includes('contain') ? 'FIT' : 'FILL',
              backgroundPosition: String(s.backgroundPosition || '50% 50%'),
              backgroundSize: String(s.backgroundSize || 'auto'),
              sectionId,
              parentContainerKey,
              zIndex: zi,
              paintPhase: 0,
            });
          }
          const bg = color(s.backgroundColor);
          const bw = borderWidth(s);
          const sh = shadow(s.boxShadow);
          const gr = gradient(s.backgroundImage);
          const huge = abs.width > viewportWidth * .98 && abs.height > 1600;
          if (!huge && e !== doc.body && e !== doc.documentElement && (bg.a > .01 || bw > .1 || sh || gr)) {
            add({
              kind: 'shape',
              name: layerName(e, ' — плашка'),
              ...base,
              opacity,
              fill: gr || (bg.a > .01 ? { kind: 'solid', color: bg } : undefined),
              stroke: bw > .1 ? color(s.borderTopColor) : undefined,
              strokeWeight: bw || undefined,
              radius: rad || undefined,
              shadow: sh || undefined,
              sectionId,
              parentContainerKey,
              zIndex: zi,
              paintPhase: 0,
            });
          }
        }

        const childParentKey = ownContainerKey || parentContainerKey;
        capturePseudo(e, '::before', sectionId, childParentKey, 0);

        if (e instanceof HTMLElement) {
          for (const node of Array.from(e.childNodes || [])) {
            if (node.nodeType !== Node.TEXT_NODE) continue;
            const text = visualText(node);
            if (!text) continue;
            const range = doc.createRange();
            try { range.selectNodeContents(node); } catch { continue; }
            const rr = range.getBoundingClientRect();
            if (rr.width <= .5 || rr.height <= .5) continue;
            const textAbs = absRect(rr);
            const textBase = positioned(textAbs, childParentKey);
            add({
              kind: 'text',
              name: layerName(e, ' — текст'),
              ...textBase,
              opacity,
              fill: { kind: 'solid', color: color(s.color) },
              text,
              textRole: /^H[1-6]$/.test(e.tagName) ? e.tagName : (e.matches('button,.t-btn,[role="button"]') ? 'Button' : 'Body'),
              fontSize: num(s.fontSize, 16),
              fontWeight: num(s.fontWeight, 400),
              fontFamily: family(s.fontFamily),
              fontStyle: String(s.fontStyle || 'normal'),
              lineHeight: lineHeightForTextNode(node, s),
              letterSpacing: s.letterSpacing === 'normal' ? 0 : num(s.letterSpacing),
              textAlign: align(s.textAlign),
              textDecoration: String(s.textDecorationLine || ''),
              textSizing: 'FIXED',
              sectionId,
              parentContainerKey: childParentKey,
              zIndex: zi,
              paintPhase: 1,
            });
          }
        }

        capturePseudo(e, '::after', sectionId, childParentKey, 2);
      }

      const root = doc.scrollingElement || doc.documentElement;
      const height = Math.min(maxHeight, Math.max(root.scrollHeight, doc.body ? doc.body.scrollHeight : 0, 1));
      return {
        width: viewportWidth,
        height,
        sections,
        layers,
        truncated,
        rendererVersion: 6,
      };
    }, { maxLayers: MAX_LAYERS, maxHeight: MAX_HEIGHT, viewportWidth: width });

    stage = 'растрирование сложных элементов';
    let embeddedBytes = 0;
    let captureOk = 0;
    let captureFailed = 0;
    for (const layer of snapshot.layers.filter((l) => l.captureId).slice(0, MAX_CAPTURE_FALLBACKS)) {
      try {
        const handle = await page.$(`[data-figma-capture-id="${String(layer.captureId).replace(/"/g, '\\"')}"]`);
        if (!handle) {
          captureFailed += 1;
          continue;
        }
        const raw = await handle.screenshot({ type: 'png', omitBackground: true });
        const normalized = await normalizeCapture(sharp, raw);
        if (embeddedBytes + normalized.length > MAX_EMBEDDED_CAPTURE_BYTES) {
          captureFailed += 1;
          continue;
        }
        layer.imageDataBase64 = normalized.toString('base64');
        layer.url = undefined;
        embeddedBytes += normalized.length;
        captureOk += 1;
      } catch {
        captureFailed += 1;
      }
    }

    stage = 'проверка результата';
    if (!snapshot.layers.length) throw new Error('После рендера не найдено ни одного видимого слоя');

    const imageLayers = snapshot.layers.filter((l) => l.kind === 'image').length;
    const textLayers = snapshot.layers.filter((l) => l.kind === 'text').length;
    const containers = snapshot.layers.filter((l) => l.kind === 'container').length;
    const unresolvedCaptures = snapshot.layers.filter((l) => l.captureId && !l.imageDataBase64).length;

    return {
      finalUrl: page.url(),
      snapshot,
      diagnostics: {
        imageLayers,
        textLayers,
        containers,
        captureOk,
        captureFailed,
        unresolvedCaptures,
        embeddedCaptureBytes: embeddedBytes,
      },
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`${stage}: ${message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Разрешены только GET и OPTIONS' });

  if (String(req.query.ping || '') === '1') {
    return res.status(200).json({ ok: true, service: 'browser-renderer', version: 6 });
  }

  const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  const rawWidth = Array.isArray(req.query.width) ? req.query.width[0] : req.query.width;
  const width = Math.max(320, Math.min(1920, Number(rawWidth) || 1440));
  if (!rawUrl) return res.status(400).json({ ok: false, error: 'Не передан параметр url' });

  try {
    const { finalUrl, snapshot, diagnostics } = await renderPage(String(rawUrl), width);
    return res.status(200).json({
      ok: true,
      mode: 'browser-snapshot-v6-fidelity',
      finalUrl,
      snapshot,
      diagnostics,
      stats: {
        layers: snapshot.layers.length,
        sections: snapshot.sections.length,
        height: snapshot.height,
        truncated: snapshot.truncated,
        ...diagnostics,
      },
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: error && error.message ? error.message : 'Не удалось отрендерить страницу',
    });
  }
};
