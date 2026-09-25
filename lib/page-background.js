function validFill(fill) {
  if (!fill || typeof fill !== 'object') return false;
  if (fill.kind === 'solid') {
    const color = fill.color;
    return !!color && [color.r, color.g, color.b, color.a].every(Number.isFinite) && Number(color.a) > 0.001;
  }
  if (fill.kind === 'linear') {
    return Number.isFinite(Number(fill.angle)) && Array.isArray(fill.stops) && fill.stops.length >= 2;
  }
  return false;
}

function materializePageBackground(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.layers) || !validFill(snapshot.pageBackground)) return 0;

  const width = Number(snapshot.width);
  const height = Number(snapshot.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;

  if (snapshot.layers.some(layer => layer && layer.name === '__html2figma_page_background__')) return 0;

  snapshot.layers.push({
    kind: 'shape',
    name: '__html2figma_page_background__',
    x: 0,
    y: 0,
    absX: 0,
    absY: 0,
    width,
    height,
    opacity: 1,
    fill: snapshot.pageBackground,
    zIndex: -200000,
    stackPath: [-200000],
    paintPhase: -200,
    z: -200000,
  });
  return 1;
}

module.exports = { materializePageBackground };
