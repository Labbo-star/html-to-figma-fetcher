function clamp(v, min, max) {
  const n = Number(v);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

function round2(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

function sectionForY(snapshot, y) {
  const sections = Array.isArray(snapshot && snapshot.sections) ? snapshot.sections : [];
  // Elementor can expose both an outer root and its child as sections. Place
  // captures in the smallest containing section so the child's opaque
  // background does not cover icons captured into the outer root.
  const hit = sections.filter(s => y >= Number(s.y || 0) - 2 && y <= Number(s.y || 0) + Number(s.height || 0) + 2)
    .sort((a, b) => Number(a.height || 0) - Number(b.height || 0))[0];
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

// Chromium renders layered CSS radial gradients correctly, while Figma's
// simple linear-fill snapshot cannot describe them. Capture only the painted
// element, keeping its text and child objects as editable snapshot layers.
async function radialBackgroundCaptures(page, snapshot) {
  const candidates = await page.evaluate(() => {
    const result = [];
    for (const el of document.querySelectorAll('.elementor *')) {
      if (!(el instanceof HTMLElement)) continue;
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (!/radial-gradient\(/i.test(style.backgroundImage) || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < .01) continue;
      if (rect.width < 180 || rect.height < 80 || rect.width * rect.height > 3200000 || rect.top + scrollY > 3000) continue;
      const id = String(result.length);
      el.setAttribute('data-h2f-radial-capture', id);
      result.push({ id, x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height });
      if (result.length >= 6) break;
    }
    return result;
  }).catch(() => []);
  let captured = 0;
  try {
    for (const item of candidates) {
      const shape = snapshot.layers.find(layer => layer && layer.kind === 'shape' &&
        near(layer.absX ?? layer.x, item.x, 4) && near(layer.absY ?? layer.y, item.y, 4) &&
        near(layer.width, item.width, 4) && near(layer.height, item.height, 4));
      if (!shape || hasVisualNear(snapshot, item.x, item.y, item.width, item.height)) continue;
      const handle = await page.$(`[data-h2f-radial-capture="${item.id}"]`);
      if (!handle) continue;
      // Hide just the element's children; its own background and rounded
      // corners stay visible. Restore every original inline style afterward.
      const visibility = await handle.evaluate(el => Array.from(el.children).map(child => {
        const value = child.style.getPropertyValue('visibility'), priority = child.style.getPropertyPriority('visibility');
        child.style.setProperty('visibility', 'hidden', 'important');
        return { value, priority };
      }));
      try {
        const data = await handle.screenshot({ type: 'png', encoding: 'base64' });
        shape.kind = 'image';
        shape.name = String(shape.name || 'Градиент').replace(/ — плашка$/, ' — градиент');
        delete shape.fill;
        shape.imageDataBase64 = String(data);
        shape.imageScaleMode = 'FILL';
        shape.captureSafe = false;
        captured++;
      } finally {
        await handle.evaluate((el, original) => Array.from(el.children).forEach((child, i) => {
          const prior = original[i];
          if (!prior) return;
          if (prior.value) child.style.setProperty('visibility', prior.value, prior.priority);
          else child.style.removeProperty('visibility');
        }), visibility).catch(() => {});
      }
    }
  } finally {
    await page.evaluate(() => document.querySelectorAll('[data-h2f-radial-capture]').forEach(el => el.removeAttribute('data-h2f-radial-capture'))).catch(() => {});
  }
  return captured;
}

// Cross-origin widgets are visible to Chromium but opaque to DOM extraction.
// Keep their rendered pixels inside the existing iframe frame in Figma.
async function iframeCaptures(page, snapshot) {
  const candidates = await page.evaluate(() => {
    const result = [];
    for (const el of document.querySelectorAll('.elementor iframe')) {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < .01 ||
        el.closest('dialog,[role="dialog"],.elementor-popup-modal,[aria-hidden="true"]')) continue;
      if (rect.width < 240 || rect.height < 120 || rect.width * rect.height > 3200000 || rect.top + scrollY > 30000) continue;
      const id = String(result.length);
      el.setAttribute('data-h2f-iframe-capture', id);
      result.push({ id, x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height });
      if (result.length >= 4) break;
    }
    return result;
  }).catch(() => []);
  let captured = 0;
  try {
    for (const item of candidates) {
      const frame = snapshot.layers.find(layer => layer && layer.kind === 'container' && /^iframe(?:[.#\s]|$)/i.test(String(layer.name || '')) &&
        near(layer.absX ?? layer.x, item.x, 5) && near(layer.absY ?? layer.y, item.y, 5) &&
        near(layer.width, item.width, 5) && near(layer.height, item.height, 5));
      if (frame && snapshot.layers.some(layer => layer.parentContainerKey === frame.containerKey && layer.kind !== 'container')) continue;
      if (textCountIn(snapshot, item) >= 3 || hasVisualNear(snapshot, item.x, item.y, item.width, item.height)) continue;
      try {
        const handle = await page.$(`[data-h2f-iframe-capture="${item.id}"]`);
        if (!handle) continue;
        const content = await handle.contentFrame();
        if (content) await content.waitForFunction(() => !!document.body && (document.body.innerText || '').trim().length > 24, { timeout: 2400 }).catch(() => {});
        const data = String(await handle.screenshot({ type: 'png', encoding: 'base64' }));
        const metrics = await require('sharp')(Buffer.from(data, 'base64')).stats();
        // A still-loading white iframe is worse than a reported missing widget.
        if (metrics.channels.slice(0, 3).every(ch => ch.stdev < 2.5 && ch.mean > 245)) continue;
        snapshot.layers.push({
          kind: 'image', name: 'iframe widget visual capture',
          x: frame ? 0 : round2(item.x), y: frame ? 0 : round2(item.y),
          absX: round2(item.x), absY: round2(item.y), width: round2(item.width), height: round2(item.height),
          opacity: 1, imageDataBase64: data, imageScaleMode: 'FILL', captureSafe: false,
          ...(frame && frame.containerKey ? { parentContainerKey: frame.containerKey } : {}),
          sectionId: frame ? frame.sectionId : sectionForY(snapshot, item.y + 2),
          zIndex: 0, stackPath: frame ? frame.stackPath : [], paintPhase: 2, z: (frame ? Number(frame.z) || 0 : 0) + .1,
        });
        captured++;
      } catch {}
    }
  } finally {
    await page.evaluate(() => document.querySelectorAll('[data-h2f-iframe-capture]').forEach(el => el.removeAttribute('data-h2f-iframe-capture'))).catch(() => {});
  }
  return captured;
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
      const parent = snapshot.layers.find(layer => layer && layer.kind === 'container' && layer.containerKey &&
        /a\.elementor-icon\.elementor-social-icon/.test(String(layer.name || '')) &&
        x >= Number(layer.absX ?? layer.x) - 1 && y >= Number(layer.absY ?? layer.y) - 1 &&
        x + w <= Number(layer.absX ?? layer.x) + Number(layer.width) + 1 &&
        y + h <= Number(layer.absY ?? layer.y) + Number(layer.height) + 1);
      snapshot.layers.push({
        kind: 'image',
        name: 'elementor social icon capture',
        x: parent ? round2(x - Number(parent.absX ?? parent.x)) : x,
        y: parent ? round2(y - Number(parent.absY ?? parent.y)) : y,
        absX: x, absY: y, width: w, height: h,
        opacity: 1,
        imageDataBase64: String(data),
        imageScaleMode: 'FIT',
        captureSafe: false,
        ...(parent ? { parentContainerKey: parent.containerKey } : {}),
        sectionId: parent ? parent.sectionId : sectionForY(snapshot, y + 1),
        zIndex: parent ? Number(parent.zIndex) || 0 : 120,
        stackPath: parent ? parent.stackPath : [120],
        paintPhase: 3,
        z: parent ? (Number(parent.z) || 0) + .1 : 900100 + added,
      });
      added++;
    } catch {}
  }
  return added;
}

async function buttonIconCaptures(page, snapshot) {
  const items = await page.evaluate(() => {
    const result = [];
    for (const el of document.querySelectorAll('.elementor .elementor-button-icon svg,.elementor .elementor-button-icon i')) {
      if (el.closest('[aria-hidden="true"],dialog,[role="dialog"]')) continue;
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      if (r.width < 8 || r.height < 8 || r.width > 90 || r.height > 90 || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < .01) continue;
      const id = String(result.length);
      el.setAttribute('data-h2f-button-icon-capture', id);
      result.push({ id, x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height });
      if (result.length >= 24) break;
    }
    return result;
  }).catch(() => []);
  let added = 0;
  try {
    for (const item of items) {
      const x = round2(item.x), y = round2(item.y), w = round2(item.width), h = round2(item.height);
      if (hasVisualNear(snapshot, x, y, w, h)) continue;
      const parent = snapshot.layers.find(layer => layer && layer.kind === 'container' && layer.containerKey &&
        /elementor-button-icon/.test(String(layer.name || '')) &&
        x >= Number(layer.absX ?? layer.x) - 2 && y >= Number(layer.absY ?? layer.y) - 2 &&
        x + w <= Number(layer.absX ?? layer.x) + Number(layer.width) + 2 &&
        y + h <= Number(layer.absY ?? layer.y) + Number(layer.height) + 2);
      try {
        const handle = await page.$(`[data-h2f-button-icon-capture="${item.id}"]`);
        if (!handle) continue;
        const data = await handle.screenshot({ type: 'png', encoding: 'base64' });
        snapshot.layers.push({
          kind: 'image', name: 'elementor button icon capture',
          x: parent ? round2(x - Number(parent.absX ?? parent.x)) : x,
          y: parent ? round2(y - Number(parent.absY ?? parent.y)) : y,
          absX: x, absY: y, width: w, height: h, opacity: 1,
          imageDataBase64: String(data), imageScaleMode: 'FIT', captureSafe: false,
          ...(parent ? { parentContainerKey: parent.containerKey } : {}),
          sectionId: parent ? parent.sectionId : sectionForY(snapshot, y + 1),
          zIndex: parent ? Number(parent.zIndex) || 0 : 120,
          stackPath: parent ? parent.stackPath : [120],
          paintPhase: 3, z: parent ? (Number(parent.z) || 0) + .1 : 900200 + added,
        });
        added++;
      } catch {}
    }
  } finally {
    await page.evaluate(() => document.querySelectorAll('[data-h2f-button-icon-capture]').forEach(el => el.removeAttribute('data-h2f-button-icon-capture'))).catch(() => {});
  }
  return added;
}

function cssColor(raw) {
  const m = String(raw || '').match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const p = m[1].split(',').map(x => Number.parseFloat(x));
  if (p.length < 3 || p.slice(0, 3).some(x => !Number.isFinite(x))) return null;
  return { r: clamp(p[0] / 255, 0, 1), g: clamp(p[1] / 255, 0, 1), b: clamp(p[2] / 255, 0, 1), a: clamp(p.length > 3 ? p[3] : 1, 0, 1) };
}

async function checkboxPseudoShapes(page, snapshot) {
  const items = await page.evaluate(() => {
    const result = [];
    for (const label of document.querySelectorAll('.elementor label')) {
      if (!label.querySelector('input[type="checkbox"]') || label.closest('[aria-hidden="true"],dialog,[role="dialog"]')) continue;
      const span = label.querySelector(':scope > span');
      if (!span) continue;
      const r = span.getBoundingClientRect(), s = getComputedStyle(span), p = getComputedStyle(span, '::before');
      const w = Number.parseFloat(p.width), h = Number.parseFloat(p.height), border = Number.parseFloat(p.borderTopWidth);
      if (r.width < 50 || r.height < 14 || !Number.isFinite(w) || !Number.isFinite(h) || w < 10 || h < 10 || w > 40 || h > 40 ||
        !(border > .1) || p.content === 'none' || p.display === 'none' || s.display !== 'flex' || Number(s.opacity) < .01) continue;
      const x = r.left + scrollX + (Number.parseFloat(s.paddingLeft) || 0);
      const y = r.top + scrollY + (s.alignItems === 'center' ? Math.max(0, (r.height - h) / 2) : 0);
      result.push({ x, y, width: w, height: h, border, color: p.borderTopColor,
        background: p.backgroundColor, radius: Number.parseFloat(p.borderTopLeftRadius) || 0 });
      if (result.length >= 16) break;
    }
    return result;
  }).catch(() => []);
  let added = 0;
  for (const item of items) {
    const x = round2(item.x), y = round2(item.y), w = round2(item.width), h = round2(item.height);
    if (snapshot.layers.some(layer => layer && layer.kind === 'shape' && near(layer.absX ?? layer.x, x, 2) && near(layer.absY ?? layer.y, y, 2) && near(layer.width, w, 2) && near(layer.height, h, 2))) continue;
    const stroke = cssColor(item.color), fill = cssColor(item.background);
    if (!stroke || stroke.a < .01) continue;
    const parent = snapshot.layers.find(layer => layer && layer.kind === 'container' && layer.containerKey &&
      /label\..*for-checkbox/.test(String(layer.name || '')) &&
      x >= Number(layer.absX ?? layer.x) - 2 && y >= Number(layer.absY ?? layer.y) - 2 &&
      x + w <= Number(layer.absX ?? layer.x) + Number(layer.width) + 2 &&
      y + h <= Number(layer.absY ?? layer.y) + Number(layer.height) + 2);
    snapshot.layers.push({
      kind: 'shape', name: 'elementor checkbox pseudo control',
      x: parent ? round2(x - Number(parent.absX ?? parent.x)) : x,
      y: parent ? round2(y - Number(parent.absY ?? parent.y)) : y,
      absX: x, absY: y, width: w, height: h, opacity: 1,
      ...(fill && fill.a > .01 ? { fill: { kind: 'solid', color: fill } } : {}),
      stroke, strokeWeight: round2(item.border), radius: round2(item.radius),
      ...(parent ? { parentContainerKey: parent.containerKey } : {}),
      sectionId: parent ? parent.sectionId : sectionForY(snapshot, y + 1),
      zIndex: parent ? Number(parent.zIndex) || 0 : 0,
      stackPath: parent ? parent.stackPath : [], paintPhase: 2,
      z: parent ? (Number(parent.z) || 0) + .1 : 900300 + added,
    });
    added++;
  }
  return added;
}

function restoreBackdropOrder(snapshot) {
  const layers = snapshot.layers || [];
  let corrected = 0;
  for (const image of layers) {
    if (!image || image.kind !== 'image' || !image.url || Number(image.width) > 600 || Number(image.height) > 650) continue;
    const ix = Number(image.absX ?? image.x), iy = Number(image.absY ?? image.y);
    const panel = layers.find(shape => shape && shape.kind === 'shape' && shape.sectionId === image.sectionId &&
      shape.fill && shape.fill.kind === 'solid' && Number(shape.fill.color?.a) >= .95 &&
      Number(shape.width) >= Number(snapshot.width) * .65 && Number(shape.height) >= 250 &&
      Number(shape.z) > Number(image.z) && iy < Number(shape.absY ?? shape.y) - 10 &&
      iy + Number(image.height) > Number(shape.absY ?? shape.y) + 10 &&
      ix + Number(image.width) > Number(shape.absX ?? shape.x) + 10 &&
      ix < Number(shape.absX ?? shape.x) + Number(shape.width) - 10);
    if (!panel) continue;
    image.stackPath = Array.isArray(panel.stackPath) ? [...panel.stackPath] : [];
    image.zIndex = Number(panel.zIndex) || 0;
    image.paintPhase = Number(panel.paintPhase) || 0;
    corrected++;
  }
  return corrected;
}

async function augmentElementorSnapshot(page, snapshot, width) {
  const stats = { heroBackgrounds: 0, radialBackgrounds: 0, iframeCaptures: 0, reviewCaptures: 0, socialIconCaptures: 0,
    buttonIconCaptures: 0, checkboxPseudoShapes: 0, backdropOrderAdjusted: 0 };
  if (!page || !snapshot || !Array.isArray(snapshot.layers)) return stats;
  stats.radialBackgrounds = await radialBackgroundCaptures(page, snapshot);
  if (!stats.radialBackgrounds) stats.heroBackgrounds = await heroBackground(page, snapshot, Number(width) || Number(snapshot.width) || 1440);
  stats.iframeCaptures = await iframeCaptures(page, snapshot);
  stats.socialIconCaptures = await socialIconCaptures(page, snapshot);
  stats.buttonIconCaptures = await buttonIconCaptures(page, snapshot);
  stats.checkboxPseudoShapes = await checkboxPseudoShapes(page, snapshot);
  stats.backdropOrderAdjusted = restoreBackdropOrder(snapshot);
  return stats;
}

module.exports = { augmentElementorSnapshot };
