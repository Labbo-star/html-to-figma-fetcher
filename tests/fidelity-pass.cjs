const assert = require('node:assert/strict');
const render = require('../lib/render24');
const { markReliableImageCaptures, mergeBrowserFidelity, isDuplicate } = render._test;

{
  const snapshot = {
    framework: 'tilda',
    layers: [
      { kind: 'image', captureId: 'imgcap-0', captureSafe: true, url: 'https://static.tildacdn.com/a.jpg' },
      { kind: 'image', captureId: 'imgcap-1', captureSafe: true, url: 'https://example.com/b.jpg' },
      { kind: 'image', captureId: 'imgcap-2', captureSafe: false, url: 'https://static.tildacdn.com/c.jpg' },
    ],
  };
  assert.equal(markReliableImageCaptures(snapshot), 2);
  assert.equal(snapshot.layers[0].preferCapture, true);
  assert.equal(snapshot.layers[1].preferCapture, true);
  assert.equal(snapshot.layers[2].preferCapture, undefined);
}

{
  const snapshot = {
    sections: [{ id: 's1', y: 0, height: 900 }],
    layers: [
      { kind: 'svg', x: 20, y: 30, absX: 20, absY: 30, width: 24, height: 24, svg: '<svg><path fill="currentColor"/></svg>' },
      { kind: 'text', x: 100, y: 20, absX: 100, absY: 20, width: 100, height: 20, text: 'Меню' },
    ],
  };
  const out = mergeBrowserFidelity(snapshot, {
    svgs: [{ kind: 'svg', x: 20, y: 30, absX: 20, absY: 30, width: 24, height: 24, svg: '<svg color="rgb(255,0,0)"><path fill="rgb(255,0,0)"/></svg>' }],
    fixed: [
      { kind: 'text', x: 100, y: 20, absX: 100, absY: 20, width: 100, height: 20, text: 'Меню' },
      { kind: 'text', x: 220, y: 20, absX: 220, absY: 20, width: 100, height: 20, text: 'Контакты' },
    ],
    pseudos: [{ kind: 'shape', x: 500, y: 300, absX: 500, absY: 300, width: 30, height: 30, fill: { kind: 'solid', color: { r: 1, g: 0, b: 0, a: 1 } } }],
  });
  assert.equal(out.svgResolved, 1);
  assert.equal(out.fixedRecovered, 1);
  assert.equal(out.pseudoRecovered, 1);
  assert.match(snapshot.layers[0].svg, /rgb\(255,0,0\)/);
  assert.equal(snapshot.layers.filter(x => x.kind === 'text' && x.text === 'Меню').length, 1);
  assert.equal(snapshot.layers.some(x => x.kind === 'text' && x.text === 'Контакты'), true);
  assert.equal(snapshot.layers.find(x => x.text === 'Контакты').sectionId, 's1');
}

{
  const snapshot = { layers: [{ kind: 'shape', absX: 10, absY: 10, width: 20, height: 20 }] };
  assert.equal(isDuplicate(snapshot, { kind: 'shape', absX: 12, absY: 11, width: 20, height: 20 }), true);
  assert.equal(isDuplicate(snapshot, { kind: 'shape', absX: 80, absY: 80, width: 20, height: 20 }), false);
}

console.log('fidelity-pass: ok');
