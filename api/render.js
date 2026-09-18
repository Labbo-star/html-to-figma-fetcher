const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_LAYERS = 2400;
const MAX_HEIGHT = 30000;
const NAV_TIMEOUT = 12000;
const VIEWPORT_HEIGHT = 1000;

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
    new Promise((resolve) => setTimeout(() => resolve(false), 1800)),
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

async function loadChromiumModules() {
  try {
    const [pupMod, chrMod] = await Promise.all([
      import('puppeteer-core'),
      import('@sparticuz/chromium'),
    ]);
    return {
      puppeteer: pupMod.default || pupMod,
      chromium: chrMod.default || chrMod,
    };
  } catch (error) {
    throw new Error(`Не удалось загрузить Chromium-модули: ${error && error.message ? error.message : error}`);
  }
}

async function renderPage(rawUrl, width) {
  let stage = 'проверка адреса';
  const safeUrl = await assertPublicUrl(rawUrl);
  const { puppeteer, chromium } = await loadChromiumModules();
  chromium.setGraphicsMode = false;

  let browser;
  try {
    stage = 'запуск Chromium';
    browser = await puppeteer.launch({
      args: [...chromium.args, '--disable-dev-shm-usage'],
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

    stage = 'ожидание Tilda';
    await Promise.race([
      page.waitForNetworkIdle({ idleTime: 250, timeout: 1700 }).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1800)),
    ]);
    await Promise.race([
      page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 900)),
    ]);

    stage = 'lazy-load';
    await page.evaluate(async (maxHeight) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const root = document.scrollingElement || document.documentElement;
      const total = Math.min(maxHeight, Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0, 1));
      for (let y = 0; y < total; y += 1300) {
        window.scrollTo(0, y);
        await sleep(28);
      }
      window.scrollTo(0, 0);
      await sleep(280);
    }, MAX_HEIGHT);

    await page.addStyleTag({
      content: '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}',
    }).catch(() => {});

    stage = 'снятие геометрии';
    const snapshot = await page.evaluate(({ maxLayers, maxHeight, viewportWidth }) => {
      const win = window;
      const doc = document;
      const layers = [];
      let seq = 0;
      let truncated = false;

      const num = (v, f = 0) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : f; };
      const round = (v) => Math.round(v * 100) / 100;
      const clean = (v) => String(v || '').replace(/\u00a0/g, ' ').replace(/[\t\r\f\v ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
      const color = (v) => {
        const m = String(v || '').match(/rgba?\(([^)]+)\)/i);
        if (!m) return { r: 0, g: 0, b: 0, a: 0 };
        const p = m[1].split(',').map((x) => Number.parseFloat(x.trim()));
        return {
          r: Math.max(0, Math.min(1, (p[0] || 0) / 255)),
          g: Math.max(0, Math.min(1, (p[1] || 0) / 255)),
          b: Math.max(0, Math.min(1, (p[2] || 0) / 255)),
          a: p.length > 3 && Number.isFinite(p[3]) ? Math.max(0, Math.min(1, p[3])) : 1,
        };
      };
      const rect = (r) => ({ x: round(r.left + win.scrollX), y: round(r.top + win.scrollY), width: round(r.width), height: round(r.height) });
      const layerName = (e, suffix = '') => ((e.tagName || 'node').toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList && e.classList.length ? '.' + Array.from(e.classList).slice(0, 2).join('.') : '') + suffix).slice(0, 100);
      const add = (layer) => {
        if (layers.length >= maxLayers) { truncated = true; return false; }
        if (!layer || !Number.isFinite(layer.x) || !Number.isFinite(layer.y) || layer.width <= .5 || layer.height <= .5) return true;
        if (layer.y > maxHeight + 500 || layer.x > viewportWidth + 1000 || layer.x + layer.width < -1000) return true;
        layer.z = seq++;
        layers.push(layer);
        return true;
      };
      const urlFromCss = (v) => {
        const m = String(v || '').match(/url\((?:"|')?([^"')]+)(?:"|')?\)/i);
        if (!m) return '';
        try { return new URL(m[1], location.href).href; } catch { return m[1]; }
      };
      const gradient = (v) => {
        const raw = String(v || '');
        if (!raw.includes('linear-gradient(')) return null;
        const cs = Array.from(raw.matchAll(/rgba?\([^)]*\)/gi)).map((m) => color(m[0]));
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
        return { color: color(cm ? cm[0] : 'rgba(0,0,0,.2)'), x: num(ns[0]), y: num(ns[1]), blur: num(ns[2]), spread: num(ns[3]) };
      };
      const radius = (s) => Math.max(num(s.borderTopLeftRadius), num(s.borderTopRightRadius), num(s.borderBottomLeftRadius), num(s.borderBottomRightRadius));
      const align = (v) => { const s = String(v || '').toLowerCase(); return s === 'center' ? 'CENTER' : (s === 'right' || s === 'end') ? 'RIGHT' : s === 'justify' ? 'JUSTIFIED' : 'LEFT'; };
      const family = (v) => String(v || 'Inter').split(',')[0].trim().replace(/^['"]|['"]$/g, '') || 'Inter';
      const lineHeight = (s) => s.lineHeight === 'normal' ? num(s.fontSize, 16) * 1.2 : num(s.lineHeight, num(s.fontSize, 16) * 1.2);

      function hiddenByState(e) {
        let n = e;
        for (let i = 0; n && n !== doc.documentElement && i < 30; i += 1, n = n.parentElement) {
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
        for (let i = 0; n && n !== doc.documentElement && i < 30; i += 1, n = n.parentElement) {
          const s = win.getComputedStyle(n);
          const ox = String(s.overflowX || s.overflow || '').toLowerCase();
          const oy = String(s.overflowY || s.overflow || '').toLowerCase();
          const clipX = ox === 'hidden' || ox === 'clip' || ox === 'scroll' || ox === 'auto';
          const clipY = oy === 'hidden' || oy === 'clip' || oy === 'scroll' || oy === 'auto';
          if (!clipX && !clipY) continue;
          const pr = n.getBoundingClientRect();
          if (clipX) { left = Math.max(left, pr.left); right = Math.min(right, pr.right); }
          if (clipY) { top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom); }
          if (right - left <= .5 || bottom - top <= .5) return true;
        }
        return false;
      }

      function visible(e, r, s) {
        if (r.width <= .5 || r.height <= .5) return false;
        if (s.display === 'none' || s.visibility === 'hidden' || num(s.opacity, 1) <= .01) return false;
        if (hiddenByState(e)) return false;
        if (clippedOut(e, r)) return false;
        return true;
      }

      const sectionEls = [];
      const seen = new Set();
      for (const e of Array.from(doc.querySelectorAll('#allrecords > .t-rec, .t-rec[id], header, main > section, footer'))) {
        if (seen.has(e)) continue;
        const s = win.getComputedStyle(e), r = e.getBoundingClientRect();
        if (!visible(e, r, s)) continue;
        seen.add(e); sectionEls.push(e);
      }
      if (!sectionEls.length && doc.body) {
        for (const e of Array.from(doc.body.children)) {
          const s = win.getComputedStyle(e), r = e.getBoundingClientRect();
          if (visible(e, r, s)) sectionEls.push(e);
        }
      }

      const sectionMap = new Map();
      const sections = sectionEls.map((e, i) => {
        const r = e.getBoundingClientRect();
        const id = 'section-' + i;
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

      const textSelectors = '.tn-atom,.t-title,.t-descr,.t-text,.t-name,.t-btn,.t-menu__link-item,h1,h2,h3,h4,h5,h6,p,button,label,li,blockquote,a';
      const candidates = Array.from(doc.querySelectorAll('body *'));
      for (const e of candidates) {
        if (truncated) break;
        if (!(e instanceof HTMLElement || e instanceof SVGElement)) continue;
        const s = win.getComputedStyle(e), r = e.getBoundingClientRect();
        if (!visible(e, r, s)) continue;
        const base = rect(r), sectionId = sectionFor(e, r), opacity = num(s.opacity, 1), rad = radius(s);

        if (e instanceof SVGElement && e.tagName.toLowerCase() === 'svg') {
          add({ kind: 'svg', name: layerName(e), ...base, opacity, svg: e.outerHTML.slice(0, 180000), sectionId });
          continue;
        }
        if (e.tagName === 'IMG') {
          const url = e.currentSrc || e.getAttribute('src') || e.getAttribute('data-original') || e.getAttribute('data-src') || '';
          if (url) add({ kind: 'image', name: layerName(e), ...base, opacity, url, radius: rad, imageScaleMode: String(s.objectFit || '').toLowerCase() === 'contain' ? 'FIT' : 'FILL', sectionId });
          continue;
        }

        const bgUrl = urlFromCss(s.backgroundImage);
        if (bgUrl) {
          add({ kind: 'image', name: layerName(e, ' — фон'), ...base, opacity, url: bgUrl, radius: rad, imageScaleMode: String(s.backgroundSize || '').includes('contain') ? 'FIT' : 'FILL', sectionId });
        } else {
          const bg = color(s.backgroundColor);
          const bw = Math.max(num(s.borderTopWidth), num(s.borderRightWidth), num(s.borderBottomWidth), num(s.borderLeftWidth));
          const sh = shadow(s.boxShadow), gr = gradient(s.backgroundImage);
          const huge = base.width > viewportWidth * .98 && base.height > 1200;
          if (!huge && e !== doc.body && e !== doc.documentElement && (bg.a > .01 || bw > .1 || sh || gr)) {
            add({ kind: 'shape', name: layerName(e, ' — фон'), ...base, opacity, fill: gr || (bg.a > .01 ? { kind: 'solid', color: bg } : undefined), stroke: bw > .1 ? color(s.borderTopColor) : undefined, strokeWeight: bw || undefined, radius: rad || undefined, shadow: sh || undefined, sectionId });
          }
        }

        if (e.matches && e.matches(textSelectors)) {
          const childTextBlock = Array.from(e.children || []).some((c) => c.matches && c.matches(textSelectors));
          if (!childTextBlock || e.classList.contains('tn-atom')) {
            const text = clean(e.innerText || e.textContent || '');
            if (text && text.length <= 12000) {
              add({ kind: 'text', name: layerName(e, ' — текст'), ...base, opacity, fill: { kind: 'solid', color: color(s.color) }, text, textRole: /^H[1-6]$/.test(e.tagName) ? e.tagName : (e.matches('button,.t-btn') ? 'Button' : 'Body'), fontSize: num(s.fontSize, 16), fontWeight: num(s.fontWeight, 400), fontFamily: family(s.fontFamily), lineHeight: lineHeight(s), letterSpacing: s.letterSpacing === 'normal' ? 0 : num(s.letterSpacing), textAlign: align(s.textAlign), textSizing: 'FIXED', sectionId });
            }
          }
        }
      }

      const root = doc.scrollingElement || doc.documentElement;
      const height = Math.min(maxHeight, Math.max(root.scrollHeight, doc.body ? doc.body.scrollHeight : 0, 1));
      return { width: viewportWidth, height, sections, layers, truncated };
    }, { maxLayers: MAX_LAYERS, maxHeight: MAX_HEIGHT, viewportWidth: width });

    stage = 'проверка результата';
    if (!snapshot.layers.length) throw new Error('После рендера не найдено ни одного видимого слоя');
    return { finalUrl: page.url(), snapshot };
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
    return res.status(200).json({ ok: true, service: 'browser-renderer', version: 3 });
  }

  const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  const rawWidth = Array.isArray(req.query.width) ? req.query.width[0] : req.query.width;
  const width = Math.max(320, Math.min(1920, Number(rawWidth) || 1440));
  if (!rawUrl) return res.status(400).json({ ok: false, error: 'Не передан параметр url' });

  try {
    const { finalUrl, snapshot } = await renderPage(String(rawUrl), width);
    return res.status(200).json({
      ok: true,
      mode: 'browser-snapshot-v3',
      finalUrl,
      snapshot,
      stats: { layers: snapshot.layers.length, sections: snapshot.sections.length, height: snapshot.height, truncated: snapshot.truncated },
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error && error.message ? error.message : 'Не удалось отрендерить страницу' });
  }
};