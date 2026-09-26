#!/usr/bin/env node
// Independent, approximate preview of the renderer's layer JSON. It does not
// execute Figma's font selection, auto layout, clipping, or image import code.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const file = process.argv[2];
const out = process.argv[3];
if (!file || !out) throw Error('Usage: node scripts/snapshot-preview.cjs snapshot.json preview.png');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const s = data.snapshot || data;
const W = Math.max(320, Math.min(1920, Math.round(Number(s.width) || 1440)));
const H = Math.max(1, Math.min(30000, Math.round(Number(s.height) || 1000)));
const scale = Math.min(1, 700 / W);
const escape = v => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const css = c => c ? `rgba(${Math.round((c.r || 0) * 255)},${Math.round((c.g || 0) * 255)},${Math.round((c.b || 0) * 255)},${c.a ?? 1})` : 'none';
const order = (a, b) => {
  const aa = a.stackPath?.length ? a.stackPath : [0];
  const bb = b.stackPath?.length ? b.stackPath : [0];
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) - (bb[i] || 0);
  return aa.length - bb.length || (a.zIndex || 0) - (b.zIndex || 0) || (a.paintPhase ?? 1) - (b.paintPhase ?? 1) || (a.z || 0) - (b.z || 0);
};
const allLayers = (s.layers || []).slice();
const containers = new Map(allLayers.filter(x => x.kind === 'container' && x.containerKey).map(x => [x.containerKey, x]));
const children = new Map(), roots = [];
for (const layer of allLayers) {
  const parent = containers.get(layer.parentContainerKey);
  if (parent && parent !== layer && (!parent.sectionId || !layer.sectionId || parent.sectionId === layer.sectionId)) {
    if (!children.has(parent.containerKey)) children.set(parent.containerKey, []);
    children.get(parent.containerKey).push(layer);
  } else roots.push(layer);
}
const layers = [], traversed = new Set();
function traverse(list) {
  for (const layer of list.slice().sort(order)) {
    if (traversed.has(layer)) continue;
    traversed.add(layer);
    layers.push(layer);
    if (layer.containerKey) traverse(children.get(layer.containerKey) || []);
  }
}
if (s.framework === 'tilda' && Array.isArray(s.sections) && s.sections.length) {
  for (const section of s.sections) traverse(roots.filter(x => x.sectionId === section.id));
  traverse(roots.filter(x => !s.sections.some(section => section.id === x.sectionId)));
} else traverse(roots);
if (layers.length !== allLayers.length) traverse(allLayers); // Recover cyclic/missing-parent layers.
const imageBytes = new Map();
async function image(layer) {
  const key = layer.url || layer.sourceUrl;
  if (!key) return null;
  if (imageBytes.has(key)) return imageBytes.get(key);
  try {
    const reply = await fetch(key, { signal: AbortSignal.timeout(12000) });
    if (!reply.ok || Number(reply.headers.get('content-length')) > 3500000) return null;
    const bytes = Buffer.from(await reply.arrayBuffer());
    if (bytes.length > 3500000) return null;
    const m = (reply.headers.get('content-type') || 'image/png').split(';')[0];
    const uri = `data:${m};base64,${bytes.toString('base64')}`;
    imageBytes.set(key, uri);
    return uri;
  } catch { return null; }
}
async function main() {
  const urls = layers.filter(x => x.kind === 'image' && !x.imageDataBase64 && (x.url || x.sourceUrl));
  for (let i = 0; i < urls.length; i += 5) await Promise.all(urls.slice(i, i + 5).map(image));
  let defs = '', body = '', missing = 0;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (!['shape', 'container', 'image', 'svg', 'text'].includes(l.kind)) continue;
    const x = Number(l.absX ?? l.x) || 0, y = Number(l.absY ?? l.y) || 0;
    const w = Math.max(0, Number(l.width) || 0), h = Math.max(0, Number(l.height) || 0);
    if (w < 1 || h < 1 || x + w <= 0 || x >= W || y + h <= 0 || y >= H) continue;
    const op = Math.max(0, Math.min(1, Number(l.opacity ?? 1)));
    if (l.kind === 'shape' || l.kind === 'container' || (l.kind === 'text' && !l.text)) {
      if (!l.fill && !l.stroke) continue;
      let fill = css(l.fill?.color);
      if (l.fill?.kind === 'linear' && Array.isArray(l.fill.stops)) {
        const id = 'g' + i;
        defs += `<linearGradient id="${id}" gradientTransform="rotate(${Number(l.fill.angle) || 180} .5 .5)">${l.fill.stops.map(stop => `<stop offset="${Math.round((stop.position || 0) * 100)}%" stop-color="${css(stop.color)}"/>`).join('')}</linearGradient>`;
        fill = `url(#${id})`;
      }
      body += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.max(0, Number(l.radius) || 0)}" fill="${fill}" stroke="${css(l.stroke)}" stroke-width="${Number(l.strokeWeight) || 0}" opacity="${op}"/>`;
    } else if (l.kind === 'image') {
      let uri = l.imageDataBase64 ? `data:image/${l.imageMimeType?.includes('jpeg') ? 'jpeg' : 'png'};base64,${l.imageDataBase64}` : imageBytes.get(l.url || l.sourceUrl);
      if (!uri) { missing++; continue; }
      const id = 'clip' + i, r = Math.max(0, Number(l.radius) || 0);
      if (r) defs += `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/></clipPath>`;
      body += `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${l.imageScaleMode === 'FIT' ? 'xMidYMid meet' : 'xMidYMid slice'}" href="${uri}" opacity="${op}"${r ? ` clip-path="url(#${id})"` : ''}/>`;
    } else if (l.kind === 'svg') {
      if (l.svg?.length < 180000) body += `<image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/svg+xml;base64,${Buffer.from(l.svg).toString('base64')}" opacity="${op}"/>`;
    } else if (l.kind === 'text') {
      const lines = String(l.text || '').split('\n');
      if (!lines.length) continue;
      const size = Number(l.fontSize) || 16, lineHeight = Number(l.lineHeight) || size * 1.2;
      const anchor = l.textAlign === 'CENTER' ? 'middle' : l.textAlign === 'RIGHT' ? 'end' : 'start';
      const tx = anchor === 'middle' ? x + w / 2 : anchor === 'end' ? x + w : x;
      const fill = css(l.fill?.color || { r: 0, g: 0, b: 0, a: 1 });
      for (let j = 0; j < lines.length; j++) body += `<text x="${tx}" y="${y + size * .9 + j * lineHeight}" fill="${fill}" opacity="${op}" font-family="${escape(l.fontFamily || 'sans-serif')}" font-size="${size}" font-weight="${Number(l.fontWeight) || 400}" text-anchor="${anchor}">${escape(lines[j])}</text>`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs><rect width="${W}" height="${H}" fill="white"/>${body}</svg>`;
  try {
    await sharp(Buffer.from(svg), { limitInputPixels: 200000000 }).png().toFile(out);
  } catch (e) {
    fs.writeFileSync(out.replace(/\.png$/, '.svg'), svg);
    throw Error('PNG rasterization failed; SVG saved: ' + e.message);
  }
  if (data.qaReference?.dataBase64) fs.writeFileSync(out.replace(/\.png$/, '-reference.webp'), Buffer.from(data.qaReference.dataBase64, 'base64'));
  console.log(JSON.stringify({ out: path.resolve(out), width: W, height: H, layers: layers.length, missingImages: missing, approx: true }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
