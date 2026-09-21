function clamp(v, min, max) {
  const n = Number(v);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

function round2(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

function sectionForY(snapshot, y) {
  const sections = Array.isArray(snapshot && snapshot.sections) ? snapshot.sections : [];
  const hit = sections.find(s => y >= Number(s.y || 0) - 2 && y <= Number(s.y || 0) + Number(s.height || 0) + 2);
  return hit ? hit.id : (sections[0] ? sections[0].id : undefined);
}

function near(a, b, d = 10) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= d;
}

function hasLargeTopBackground(snapshot, width) {
  return (snapshot.layers || []).some(layer => {
    if (!layer || !['shape', 'container'].includes(layer.kind)) return false;
    const y = Number(layer.absY ?? layer.y) || 0;
    const w = Number(layer.width) || 0;
    const h = Number(layer.height) || 0;
    const c = layer.fill && layer.fill.kind === 'solid' ? layer.fill.color : null;
    if (!c || Number(c.a) < .12 || y > 1300 || w < width * .72 || h < 220) return false;
    const almostWhite = Number(c.r) > .94 && Number(c.g) > .94 && Number(c.b) > .94;
    return !almostWhite;
  });
}

function hasVisualNear(snapshot, x, y, w, h) {
  return (snapshot.layers || []).some(layer => {
    if (!layer || !['image', 'svg'].includes(layer.kind)) return false;
    const lx = Number(layer.absX ?? layer.x) || 0;
    const ly = Number(layer.absY ?? layer.y) || 0;
    const lw = Number(layer.width) || 0;
    const lh = Number(layer.height) || 0;
    return near(lx, x, 8) && near(ly, y, 8) && Math.abs(lw - w) <= 14 && Math.abs(lh - h) <= 14;
  });
}

function textCountIn(snapshot, box) {
  return (snapshot.layers || []).filter(layer => {
    if (!layer || layer.kind !== 'text') return false;
    const x = Number(layer.absX ?? layer.x) || 0;
    const y = Number(layer.absY ?? layer.y) || 0;
    const w = Number(layer.width) || 0;
    const h = Number(layer.height) || 0;
    return x + w > box.x && x < box.x + box.width && y + h > box.y && y < box.y + box.height;
  }).length;
}

async function heroBackground(page, snapshot, width) {
  if (hasLargeTopBackground(snapshot, width)) return 0;
  const candidate = await page.evaluate(() => {
    const rgba = raw => {
      const m = String(raw || '').match(/rgba?\(([^)]+)\)/i);
      if (!m) return null;
      const p = m[1].split(',').map(v => Number.parseFloat(v.trim()));
      if (p.length < 3 || p.some((v, i) => i < 3 && !Number.isFinite(v))) return null;
      return {
        r: Math.max(0, Math.min(1, p[0] / 255)),
        g: Math.max(0, Math.min(1, p[1] / 255)),
        b: Math.max(0, Math.min(1, p[2] / 255)),
        a: p.length > 3 && Number.isFinite(p[3]) ? Math.max(0, Math.min(1, p[3])) : 1,
      };
    };
    const roots = Array.from(document.querySelectorAll('.elementor[data-elementor-id] > .e-con.e-parent,.elementor[data-elementor-id] > .elementor-top-section,main > .e-con.e-parent,main > .elementor-section'));
    const pool = [];
    for (const root of roots.slice(0, 5)) {
      const rr = root.getBoundingClientRect();
      if (rr.top + scrollY > 1500 || rr.width < innerWidth * .7 || rr.height < 220) continue;
      const els = [root, ...Array.from(root.querySelectorAll(':scope > .e-con,:scope > .elementor-element,.elementor-background-overlay')).slice(0, 16)];
      for (const el of els) {
        if (!(el instanceof HTMLElement)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < innerWidth * .65 || r.height < Math.min(220, rr.height * .45)) continue;
        const styles = [getComputedStyle(el), getComputedStyle(el, '::before'), getComputedStyle(el, '::after')];
        for (const s of styles) {
          if (!s || s.display === 'none' || s.visibility === 'hidden') continue;
          const c = rgba(s.backgroundColor);
          if (!c || c.a <= .08) continue;
          const almostWhite = c.r > .94 && c.g > .94 && c.b > .94;
          if (almostWhite) continue;
          const saturation = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
          const area = Math.max(1, r.width * r.height);
          const score = area * (1 + saturation * 2) - Math.max(0, r.top + scrollY) * 80;
          pool.push({ x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, color: c, score });
        }
      }
    }
    pool.sort((a, b) => b.score - a.score);
    return pool[0] || null;
  }).catch(() => null);

  if (!candidate) return 0;
  const y = round2(candidate.y);
  snapshot.layers.push({
    kind: 'shape',
    name: 'elementor hero background proxy',
    x: round2(candidate.x),
    y,
    absX: round2(candidate.x),
    absY: y,
    width: round2(candidate.width),
    height: round2(candidate.height),
    opacity: clamp(candidate.color && candidate.color.a, 0, 1),
    fill: { kind: 'solid', color: { ...candidate.color, a: 1 } },
    sectionId: sectionForY(snapshot, y + 2),
    zIndex: -90000,
    stackPath: [-90000],
    paintPhase: -90,
    z: -90000,
  });
  return 1;
}

async function reviewCapture(page, snapshot) {
  const box = await page.evaluate(() => {
    const norm = v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,.elementor-heading-title'));
    const heading = headings.find(el => norm(el.textContent).includes('что говорят клиенты'));
    if (!heading) return null;
    let section = heading.closest('.e-con.e-parent,.elementor-top-section,.elementor-section');
    if (!section) section = heading.parentElement;
    if (!section) return null;
    const hr = heading.getBoundingClientRect();
    const sr = section.getBoundingClientRect();
    const top = Math.max(hr.bottom + 12, sr.top + Math.min(110, sr.height * .2));
    const bottom = Math.min(sr.bottom, top + 760);
    const left = Math.max(0, sr.left);
    const right = Math.min(innerWidth, sr.right);
    if (right - left < 220 || bottom - top < 90) return null;
    return { x: left + scrollX, y: top + scrollY, width: right - left, height: bottom - top };
  }).catch(() => null);
  if (!box) return 0;

  // If the core already extracted several text nodes in the review body, keep
  // the editable result and do not rasterize it.
  if (textCountIn(snapshot, box) >= 3) return 0;

  try {
    const buffer = await page.screenshot({
      type: 'png',
      encoding: 'base64',
      captureBeyondViewport: true,
      clip: {
        x: Math.max(0, Number(box.x) || 0),
        y: Math.max(0, Number(box.y) || 0),
        width: Math.max(1, Number(box.width) || 1),
        height: Math.max(1, Number(box.height) || 1),
      },
    });
    const y = round2(box.y);
    snapshot.layers.push({
      kind: 'image',
      name: 'elementor reviews visual capture',
      x: round2(box.x),
      y,
      absX: round2(box.x),
      absY: y,
      width: round2(box.width),
      height: round2(box.height),
      opacity: 1,
      imageDataBase64: String(buffer),
      imageScaleMode: 'FILL',
      captureSafe: false,
      sectionId: sectionForY(snapshot, y + 2),
      zIndex: 80,
      stackPath: [80],
      paintPhase: 2,
      z: 900000,
    });
    return 1;
  } catch {
    return 0;
  }
}

async function socialIconCaptures(page, snapshot) {
  const items = await page.evaluate(() => {
    const norm = v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const heading = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,.elementor-heading-title')).find(el => /наши\s+соц/.test(norm(el.textContent)));
    if (!heading) return [];
    const scope = heading.closest('.e-con.e-parent,.elementor-top-section,.elementor-section,footer') || heading.parentElement;
    if (!scope) return [];
    const brands = /(instagram\.com|vk\.com|dribbble\.com|pinterest\.|behance\.net|facebook\.com|youtube\.com|tiktok\.com)/i;
    const result = [];
    let seq = 0;
    for (const a of Array.from(scope.querySelectorAll('a[href]'))) {
      if (!(a instanceof HTMLElement) || !brands.test(a.getAttribute('href') || '')) continue;
      const candidates = [
        ...Array.from(a.querySelectorAll('svg,i,[class*="icon"],span')),
        a,
      ];
      let target = null;
      for (const el of candidates) {
        if (!(el instanceof HTMLElement || el instanceof SVGElement)) continue;
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        if (r.width < 8 || r.height < 8 || r.width > 110 || r.height > 110 || s.display === 'none' || s.visibility === 'hidden' || Number.parseFloat(s.opacity || '1') <= .01) continue;
        target = el;
        break;
      }
      if (!target) continue;
      const id = String(seq++);
      target.setAttribute('data-h2f-social-icon-capture', id);
      const r = target.getBoundingClientRect();
      result.push({ id, x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height });
      if (result.length >= 12) break;
    }
    return result;
  }).catch(() => []);

  let added = 0;
  for (const item of items) {
    const x = round2(item.x), y = round2(item.y), w = round2(item.width), h = round2(item.height);
    if (hasVisualNear(snapshot, x, y, w, h)) continue;
    try {
      const handle = await page.$(`[data-h2f-social-icon-capture="${String(item.id).replace(/"/g, '')}"]`);
      if (!handle) continue;
      const data = await handle.screenshot({ type: 'png', encoding: 'base64' });
      snapshot.layers.push({
        kind: 'image',
        name: 'elementor social icon capture',
        x, y, absX: x, absY: y, width: w, height: h,
        opacity: 1,
        imageDataBase64: String(data),
        imageScaleMode: 'FIT',
        captureSafe: false,
        sectionId: sectionForY(snapshot, y + 1),
        zIndex: 120,
        stackPath: [120],
        paintPhase: 3,
        z: 900100 + added,
      });
      added++;
    } catch {}
  }
  return added;
}

async function augmentElementorSnapshot(page, snapshot, width) {
  const stats = { heroBackgrounds: 0, reviewCaptures: 0, socialIconCaptures: 0 };
  if (!page || !snapshot || !Array.isArray(snapshot.layers)) return stats;
  stats.heroBackgrounds = await heroBackground(page, snapshot, Number(width) || Number(snapshot.width) || 1440);
  stats.reviewCaptures = await reviewCapture(page, snapshot);
  stats.socialIconCaptures = await socialIconCaptures(page, snapshot);
  return stats;
}

module.exports = { augmentElementorSnapshot };
