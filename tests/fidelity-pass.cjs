const assert = require('node:assert/strict');
const render = require('../lib/render24');
const { markReliableImageCaptures, mergeBrowserFidelity, isDuplicate } = render._test;

{
  const snapshot = {
    framework: 'tilda',
    layers: [
      { kind: 'image', captureId: 'imgcap-0', captureSafe: true, url: 'https://static.tildacdn.com/a.jpg', preferCapture: true },
      { kind: 'image', captureId: 'imgcap-1', captureSafe: true, url: 'https://example.com/b.svg' },
      { kind: 'image', captureId: 'imgcap-2', captureSafe: false, url: 'https://static.tildacdn.com/c.jpg' },
      { kind: 'image', captureId: 'bgcap-0', captureSafe: true, captureMode: 'background', url: 'https://static.tildacdn.com/photo.png', backgroundSize: 'cover', preferCapture: true },
      { kind: 'image', captureId: 'bgcap-1', captureSafe: true, captureMode: 'background', url: 'https://static.tildacdn.com/photo.jpg', backgroundSize: '101.9%', preferCapture: true },
      { kind: 'image', captureId: 'imgcap-3', captureSafe: true },
    ],
  };
  assert.equal(markReliableImageCaptures(snapshot), 1);
  assert.equal(snapshot.layers[0].preferCapture, false);
  assert.equal(snapshot.layers[1].preferCapture, false);
  assert.equal(snapshot.layers[2].preferCapture, undefined);
  assert.equal(snapshot.layers[3].preferCapture, false); // transparent pet image
  assert.equal(snapshot.layers[4].preferCapture, false); // cropped photo
  assert.equal(snapshot.layers[5].preferCapture, true);
}

{
  const snapshot = {
    width: 1440,
    height: 900,
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
      { kind: 'text', x: 1480, y: 20, absX: 1480, absY: 20, width: 100, height: 20, text: 'Скрытое мобильное меню' },
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
  assert.equal(snapshot.layers.some(x => x.text === 'Скрытое мобильное меню'), false);
}

{
  const snapshot = { layers: [{ kind: 'shape', absX: 10, absY: 10, width: 20, height: 20 }] };
  assert.equal(isDuplicate(snapshot, { kind: 'shape', absX: 12, absY: 11, width: 20, height: 20 }), true);
  assert.equal(isDuplicate(snapshot, { kind: 'shape', absX: 80, absY: 80, width: 20, height: 20 }), false);
}

{
  const { chromiumExecutablePath } = require('../lib/render17')._test;
  let calls = 0, finish;
  const chromium = { executablePath() { calls++; return new Promise(resolve => { finish = resolve; }); } };
  (async () => {
    const first = chromiumExecutablePath(chromium), second = chromiumExecutablePath(chromium);
    await Promise.resolve();
    assert.equal(calls, 1);
    finish('/tmp/chromium');
    assert.deepEqual(await Promise.all([first, second]), ['/tmp/chromium', '/tmp/chromium']);
    console.log('fidelity-pass: ok');
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
