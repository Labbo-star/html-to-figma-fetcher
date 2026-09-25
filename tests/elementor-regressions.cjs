const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { augmentElementorSnapshot } = require('../lib/elementor-fidelity');

function dynamicTextFixture() {
  const source = fs.readFileSync(path.resolve(__dirname, '../api/render7.js'), 'utf8');
  const start = source.indexOf('function finalizeElementorDynamicText() {');
  const end = source.indexOf('\nconst corePath =', start);
  assert.ok(start >= 0 && end > start);
  const numbers = ['150', '6', '50'].map(value => ({
    textContent: '3', getAttribute: key => key === 'data-to-value' ? value : null,
    closest: () => null,
  }));
  const label = { textContent: '+7 (914) 627 63-57', querySelectorAll: () => Array(19).fill({}) };
  const link = { closest: () => null, querySelector: selector => selector === '.elementor-button-text' ? label : null };
  const document = {
    querySelector: selector => selector.includes('.elementor') ? {} : null,
    querySelectorAll: selector => selector.includes('counter-number') ? numbers : selector.includes('tel:') ? [link] : [],
  };
  const stats = vm.runInNewContext(`(${source.slice(start, end)})()`, { document });
  assert.deepEqual(numbers.map(el => el.textContent), ['150', '6', '50']);
  assert.equal(label.textContent, '+7 (914) 627 63-57');
  assert.equal(stats.counters, 3);
  assert.equal(stats.phoneLabels, 1);
}

async function visualLayersFixture() {
  const sections = [
    { id: 'section-6', y: 3200, height: 950 },
    { id: 'section-11', y: 7210, height: 703 },
    { id: 'section-12', y: 7210, height: 631 },
  ];
  const layers = [
    { kind: 'image', name: 'decorative quiz image', url: 'https://example.test/metal.png', absX: -64, absY: 3336,
      width: 351, height: 365, sectionId: 'section-6', stackPath: [0], paintPhase: 2, zIndex: 0, z: 116 },
    { kind: 'shape', name: 'quiz white panel', absX: 20, absY: 3512, width: 1400, height: 591,
      fill: { kind: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }, sectionId: 'section-6',
      stackPath: [], paintPhase: 0, zIndex: 0, z: 117 },
    { kind: 'container', name: 'span.elementor-button-icon — контейнер', absX: 200, absY: 7626,
      width: 20, height: 20, containerKey: 'presentation-icon', sectionId: 'section-12', stackPath: [], z: 277 },
    { kind: 'container', name: 'label.jet-form-builder__field-label.for-checkbox — контейнер',
      absX: 730, absY: 7616, width: 680, height: 40, containerKey: 'consent-label',
      sectionId: 'section-12', stackPath: [], z: 295 },
    ...Array.from({ length: 5 }, (_, i) => ({ kind: 'container', name: 'a.elementor-icon.elementor-social-icon — контейнер',
      absX: 30 + i * 55, absY: 7771, width: 50, height: 50,
      containerKey: `social-${i}`, sectionId: 'section-12', stackPath: [], z: 278 + i })),
  ];
  const page = {
    evaluate: async fn => {
      const source = String(fn);
      if (source.includes("'.elementor .elementor-button-icon svg")) return [{ id: '0', x: 200, y: 7626, width: 20, height: 20 }];
      if (source.includes("'.elementor label'")) return [{ x: 730, y: 7625, width: 22, height: 22,
        border: 1, color: 'rgb(173, 181, 189)', background: 'rgba(0, 0, 0, 0)', radius: 8 }];
      if (source.includes('data-h2f-social-icon-capture') && source.includes('const brands'))
        return Array.from({ length: 5 }, (_, i) => ({ id: String(i), x: 42 + i * 55, y: 7783, width: 25, height: 25 }));
      if (source.includes('data-h2f-radial-capture') || source.includes("'.elementor iframe'")) return [];
      return null;
    },
    $: async () => ({ screenshot: async () => 'aWNvbg==' }),
  };
  const snapshot = { width: 1440, sections, layers };
  const stats = await augmentElementorSnapshot(page, snapshot, snapshot.width);
  assert.equal(stats.socialIconCaptures, 5);
  assert.equal(stats.buttonIconCaptures, 1);
  assert.equal(stats.checkboxPseudoShapes, 1);
  assert.equal(stats.backdropOrderAdjusted, 1);
  const icons = snapshot.layers.filter(l => l.name === 'elementor social icon capture');
  assert.deepEqual(icons.map(l => l.parentContainerKey), ['social-0', 'social-1', 'social-2', 'social-3', 'social-4']);
  assert.ok(icons.every(l => l.sectionId === 'section-12' && l.x === 12 && l.y === 12));
  const download = snapshot.layers.find(l => l.name === 'elementor button icon capture');
  assert.equal(download.parentContainerKey, 'presentation-icon');
  assert.equal(download.sectionId, 'section-12');
  const consent = snapshot.layers.find(l => l.name === 'elementor checkbox pseudo control');
  assert.equal(consent.parentContainerKey, 'consent-label');
  assert.equal(consent.sectionId, 'section-12');
  assert.equal(consent.strokeWeight, 1);
  assert.deepEqual(layers[0].stackPath, []);
  assert.equal(layers[0].paintPhase, 0);
  assert.ok(layers[0].z < layers[1].z);
}

(async () => {
  dynamicTextFixture();
  await visualLayersFixture();
  console.log('PASS final counters, full phone, footer icons and consent, quiz artwork ordering');
})().catch(error => { console.error(error); process.exitCode = 1; });
