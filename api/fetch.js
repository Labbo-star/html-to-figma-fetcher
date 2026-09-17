const dns = require('node:dns').promises;
const net = require('node:net');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const MAX_LAYERS = 2600;
const MAX_PAGE_HEIGHT = 30000;
const NAV_TIMEOUT_MS = 25000;
const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 1000;

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
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase().split('%')[0];
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith('::ffff:')) {
    const v4 = value.slice(7);
    if (net.isIP(v4) === 4) return isPrivateIPv4(v4);
  }
  return false;
}

function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true;
}

const hostSafetyCache = new Map();
async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Некорректный URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Разрешены только http/https ссылки');
  }
  if (url.username || url.password) {
    throw new Error('URL с логином/паролем не поддерживаются');
  }

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

  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch(() => []),
    dns.resolve6(hostname).catch(() => []),
  ]);
  const addresses = [...v4, ...v6];
  const safe = addresses.length > 0 && !addresses.some(isPrivateIp);
  hostSafetyCache.set(hostname, safe);
  if (!addresses.length) throw new Error('Домен не найден');
  if (!safe) throw new Error('Сайт ведёт на приватный IP-адрес');
  return url;
}

async function renderSnapshot(startUrl, width) {
  const safeStart = await assertPublicUrl(startUrl);
  chromium.setGraphicsMode = false;

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: 'shell',
    defaultViewport: {
      width,
      height: VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    },
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
        await assertPublicUrl(target);
        const type = request.resourceType();
        if (type === 'media' || type === 'websocket' || type === 'eventsource') {
          await request.abort('blockedbyclient');
        } else {
          await request.continue();
        }
      } catch {
        try { await request.abort('blockedbyclient'); } catch {}
      }
    });

    await page.goto(safeStart.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    try { await page.waitForNetworkIdle({ idleTime: 500, timeout: 7000 }); } catch {}
    try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch {}

    await page.evaluate(async (maxHeight) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const root = document.scrollingElement || document.documentElement;
      const total = Math.min(maxHeight, Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0));
      for (let y = 0; y < total; y += 700) {
        window.scrollTo(0, y);
        await sleep(60);
      }
      window.scrollTo(0, 0);
      await sleep(450);
    }, MAX_PAGE_HEIGHT);

    await page.addStyleTag({
      content: '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}',
    }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 250));

    const finalUrl = page.url();
    await assertPublicUrl(finalUrl);

    const snapshot = await page.evaluate(({ maxLayers, maxHeight, viewportWidth }) => {
      const win = window;
      const doc = document;
      const layers = [];
      let truncated = false;
      let seq = 0;

      function n(v, fallback = 0) {
        const x = Number.parseFloat(v);
        return Number.isFinite(x) ? x : fallback;
      }
      function round(v) { return Math.round(v * 100) / 100; }
      function cleanText(v) {
        return String(v || '').replace(/\u00a0/g, ' ').replace(/[\t\r\f\v ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
      }
      function color(v) {
        const m = String(v || '').match(/rgba?\(([^)]+)\)/i);
        if (!m) return { r: 0, g: 0, b: 0, a: 0 };
        const p = m[1].split(',').map((x) => Number.parseFloat(x.trim()));
        return {
          r: Math.max(0, Math.min(1, (p[0] || 0) / 255)),
          g: Math.max(0, Math.min(1, (p[1] || 0) / 255)),
          b: Math.max(0, Math.min(1, (p[2] || 0) / 255)),
          a: p.length > 3 && Number.isFinite(p[3]) ? Math.max(0, Math.min(1, p[3])) : 1,
        };
      }
      function rectData(r) {
        return { x: round(r.left + win.scrollX), y: round(r.top + win.scrollY), width: round(r.width), height: round(r.height) };
      }
      function visible(r, s) {
        return r.width > 0.5 && r.height > 0.5 && s.display !== 'none' && s.visibility !== 'hidden' && n(s.opacity, 1) > 0.01;
      }
      function nameFor(e, suffix = '') {
        const id = e.id ? '#' + e.id : '';
        const cls = e.classList && e.classList.length ? '.' + Array.from(e.classList).slice(0, 2).join('.') : '';
        return (e.tagName.toLowerCase() + id + cls + suffix).slice(0, 100);
      }
      function add(layer) {
        if (layers.length >= maxLayers) { truncated = true; return false; }
        if (!layer || !Number.isFinite(layer.x) || !Number.isFinite(layer.y) || layer.width <= 0 || layer.height <= 0) return true;
        if (layer.y > maxHeight + 1000 || layer.x > viewportWidth + 1000 || layer.x + layer.width < -1000) return true;
        layer.z = seq++;
        layers.push(layer);
        return true;
      }
      function firstUrl(value) {
        const m = String(value || '').match(/url\((?:"|')?([^"')]+)(?:"|')?\)/i);
        if (!m || !m[1]) return '';
        try { return new URL(m[1], location.href).href; } catch { return m[1]; }
      }
      function parseLinearGradient(value) {
        const raw = String(value || '');
        if (!raw.includes('linear-gradient(')) return null;
        const colors = Array.from(raw.matchAll(/rgba?\([^)]*\)/gi)).map((m) => color(m[0]));
        if (colors.length < 2) return null;
        const angleMatch = raw.match(/linear-gradient\(\s*(-?[\d.]+)deg/i);
        const angle = angleMatch ? n(angleMatch[1], 180) : 180;
        return {
          kind: 'linear',
          angle,
          stops: colors.slice(0, 8).map((c, i, a) => ({ position: a.length === 1 ? 0 : i / (a.length - 1), color: c })),
        };
      }
      function parseShadow(value) {
        const raw = String(value || '');
        if (!raw || raw === 'none' || raw.includes('inset')) return null;
        const cm = raw.match(/rgba?\([^)]*\)/i);
        const nums = raw.replace(cm ? cm[0] : '', '').match(/-?[\d.]+px/g) || [];
        if (nums.length < 2) return null;
        return {
          color: color(cm ? cm[0] : 'rgba(0,0,0,.2)'),
          x: n(nums[0]), y: n(nums[1]), blur: n(nums[2]), spread: n(nums[3]),
        };
      }
      function radius(s) {
        return Math.max(n(s.borderTopLeftRadius), n(s.borderTopRightRadius), n(s.borderBottomLeftRadius), n(s.borderBottomRightRadius));
      }
      function textAlign(v) {
        const x = String(v || '').toLowerCase();
        if (x === 'center') return 'CENTER';
        if (x === 'right' || x === 'end') return 'RIGHT';
        if (x === 'justify') return 'JUSTIFIED';
        return 'LEFT';
      }
      function textRole(e, text) {
        if (/^H[1-6]$/.test(e.tagName)) return e.tagName;
        if (e.matches('button,.t-btn,[role="button"]')) return 'Button';
        if (/^\s*\d{1,3}\s*$/.test(text)) return 'Number';
        return 'Body';
      }
      function fontFamily(v) {
        return String(v || 'Inter').split(',')[0].trim().replace(/^['"]|['"]$/g, '') || 'Inter';
      }
      function lineHeight(s) {
        return s.lineHeight === 'normal' ? n(s.fontSize, 16) * 1.2 : n(s.lineHeight, n(s.fontSize, 16) * 1.2);
      }
      function ownOrInlineText(e) {
        const inlineTags = new Set(['SPAN','STRONG','B','EM','I','U','SMALL','SUP','SUB','BR','MARK','CODE']);
        const children = Array.from(e.children || []);
        const onlyInline = children.every((c) => inlineTags.has(c.tagName));
        const own = cleanText(Array.from(e.childNodes || []).filter((x) => x.nodeType === Node.TEXT_NODE).map((x) => x.textContent || '').join(' '));
        if (own) return own;
        if (onlyInline) return cleanText(e.innerText || e.textContent || '');
        return '';
      }
      function textCandidate(e, text) {
        if (!text) return false;
        if (e.matches('.tn-atom,.t-title,.t-descr,.t-text,.t-name,.t-btn,.t-menu__link-item,h1,h2,h3,h4,h5,h6,p,button,label,li,blockquote')) return true;
        if (e.tagName === 'A' && text.length < 220) return true;
        if (['SPAN','STRONG','B','EM','I','SMALL'].includes(e.tagName) && text.length < 180) return true;
        return false;
      }
      function meaningfulVisual(e, s, r) {
        if (e === doc.body || e === doc.documentElement) return false;
        if (r.width < 2 || r.height < 2) return false;
        const bg = color(s.backgroundColor);
        const borderWidth = Math.max(n(s.borderTopWidth), n(s.borderRightWidth), n(s.borderBottomWidth), n(s.borderLeftWidth));
        const shadow = s.boxShadow && s.boxShadow !== 'none';
        return bg.a > 0.01 || borderWidth > 0.1 || shadow;
      }

      const sectionElements = [];
      const seenSections = new Set();
      const tildaCandidates = doc.querySelectorAll('#allrecords > .t-rec, .t-rec[id], header, main > section, footer');
      for (const el of tildaCandidates) {
        if (seenSections.has(el)) continue;
        const s = win.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (!visible(r, s)) continue;
        seenSections.add(el);
        sectionElements.push(el);
      }
      if (!sectionElements.length && doc.body) {
        for (const el of Array.from(doc.body.children)) {
          const s = win.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if (visible(r, s)) sectionElements.push(el);
        }
      }

      const sectionMap = new Map();
      const sections = sectionElements.map((el, i) => {
        const r = el.getBoundingClientRect();
        const id = 'section-' + i;
        sectionMap.set(el, id);
        return {
          id,
          name: (el.id || (el.classList && el.classList[0]) || el.tagName.toLowerCase()).slice(0, 90),
          y: round(r.top + win.scrollY),
          height: Math.max(1, round(r.height)),
        };
      });

      function sectionIdFor(e, r) {
        const closest = e.closest ? e.closest('.t-rec,header,section,footer') : null;
        if (closest && sectionMap.has(closest)) return sectionMap.get(closest);
        const y = r.top + win.scrollY + Math.min(10, r.height / 2);
        for (const sec of sections) if (y >= sec.y - 2 && y <= sec.y + sec.height + 2) return sec.id;
        if (sections.length) {
          let best = sections[0];
          let dist = Math.abs(y - best.y);
          for (const sec of sections) {
            const d = Math.abs(y - sec.y);
            if (d < dist) { dist = d; best = sec; }
          }
          return best.id;
        }
        return undefined;
      }

      function walk(e, suppressText) {
        if (truncated || !(e instanceof HTMLElement || e instanceof SVGElement)) return;
        const s = win.getComputedStyle(e);
        const r = e.getBoundingClientRect();
        if (!visible(r, s)) return;
        const base = rectData(r);
        const sectionId = sectionIdFor(e, r);
        const opacity = n(s.opacity, 1);
        const rad = radius(s);

        if (e instanceof SVGElement && e.tagName.toLowerCase() === 'svg') {
          add({ kind: 'svg', name: nameFor(e), ...base, opacity, svg: e.outerHTML.slice(0, 200000), sectionId });
          return;
        }

        if (e.tagName === 'IMG') {
          const url = e.currentSrc || e.getAttribute('src') || e.getAttribute('data-original') || e.getAttribute('data-src') || '';
          if (url) add({ kind: 'image', name: nameFor(e), ...base, opacity, url, radius: rad, imageScaleMode: String(s.objectFit || '').toLowerCase() === 'contain' ? 'FIT' : 'FILL', sectionId });
          return;
        }

        const bgImage = firstUrl(s.backgroundImage);
        if (bgImage && base.width > 2 && base.height > 2) {
          add({ kind: 'image', name: nameFor(e, ' — фон'), ...base, opacity, url: bgImage, radius: rad, imageScaleMode: String(s.backgroundSize || '').includes('contain') ? 'FIT' : 'FILL', sectionId });
        } else {
          const gradient = parseLinearGradient(s.backgroundImage);
          const bg = color(s.backgroundColor);
          const borderWidth = Math.max(n(s.borderTopWidth), n(s.borderRightWidth), n(s.borderBottomWidth), n(s.borderLeftWidth));
          const border = borderWidth > 0.1 ? color(s.borderTopColor) : null;
          const shadow = parseShadow(s.boxShadow);
          if (meaningfulVisual(e, s, r)) {
            add({
              kind: 'shape', name: nameFor(e, ' — фон'), ...base, opacity,
              fill: gradient || (bg.a > 0.01 ? { kind: 'solid', color: bg } : undefined),
              stroke: border || undefined, strokeWeight: borderWidth || undefined,
              radius: rad || undefined, shadow: shadow || undefined, sectionId,
            });
          }
        }

        let capturedText = false;
        if (!suppressText) {
          const text = ownOrInlineText(e);
          if (textCandidate(e, text)) {
            const fill = color(s.color);
            add({
              kind: 'text', name: nameFor(e, ' — текст'), ...base, opacity,
              fill: { kind: 'solid', color: fill }, text,
              textRole: textRole(e, text), fontSize: n(s.fontSize, 16),
              fontWeight: n(s.fontWeight, 400), fontFamily: fontFamily(s.fontFamily),
              lineHeight: lineHeight(s), letterSpacing: s.letterSpacing === 'normal' ? 0 : n(s.letterSpacing, 0),
              textAlign: textAlign(s.textAlign), textSizing: 'FIXED', sectionId,
            });
            capturedText = true;
          }
        }

        for (const child of Array.from(e.children || [])) walk(child, suppressText || capturedText);
      }

      if (doc.body) walk(doc.body, false);

      const root = doc.scrollingElement || doc.documentElement;
      const pageHeight = Math.min(maxHeight, Math.max(root.scrollHeight, doc.body ? doc.body.scrollHeight : 0, 1));
      return { width: viewportWidth, height: pageHeight, layers, sections, truncated };
    }, { maxLayers: MAX_LAYERS, maxHeight: MAX_PAGE_HEIGHT, viewportWidth: width });

    return {
      finalUrl,
      snapshot,
      stats: {
        layers: snapshot.layers.length,
        sections: snapshot.sections.length,
        height: snapshot.height,
        truncated: snapshot.truncated,
      },
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Разрешены только GET и OPTIONS' });
    return;
  }

  const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  const rawWidth = Array.isArray(req.query.width) ? req.query.width[0] : req.query.width;
  const width = Math.max(320, Math.min(1920, Number(rawWidth) || VIEWPORT_WIDTH));

  if (!rawUrl) {
    res.status(400).json({ ok: false, error: 'Не передан параметр url' });
    return;
  }

  try {
    const result = await renderSnapshot(String(rawUrl), width);
    res.status(200).json({ ok: true, mode: 'rendered-snapshot', ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось отрендерить страницу';
    res.status(502).json({ ok: false, error: message });
  }
};
