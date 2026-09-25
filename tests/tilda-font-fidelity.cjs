const assert = require('node:assert/strict');
const { captureTildaHeadlines } = require('../lib/tilda-text-fidelity');

(async () => {
  const events = [];
  const page = {
    viewport: () => ({ width: 1440, height: 1100 }),
    evaluate: async (fn, input) => {
      events.push(input ? ['mount', input.id] : ['cleanup']);
      return input ? { width: Math.ceil(input.width), height: Math.ceil(input.height) } : undefined;
    },
    screenshot: async opts => {
      assert.equal(opts.omitBackground, true);
      assert.equal(opts.clip.width, 700);
      return Buffer.from('opaque browser glyphs');
    },
  };
  const headline = { kind: 'text', text: '15 лет опыта', textCaptureId: 'txtcap-1',
    fontFamily: 'DrukTextWideTT', fontSize: 136, width: 700, height: 200, absX: 10, absY: 5000, opacity: .85 };
  const common = { ...headline, textCaptureId: 'txtcap-2', fontFamily: 'Inter' };
  const snapshot = { layers: [headline, common] };
  const stats = await captureTildaHeadlines(page, snapshot);
  assert.deepEqual(stats, { attempted: 1, captured: 1, errors: 0 });
  assert.deepEqual(events, [['mount', 'txtcap-1'], ['cleanup']]);
  assert.equal(headline.opacity, 0);
  assert.equal(common.opacity, .85);
  assert.equal(snapshot.layers.length, 3);
  const visible = snapshot.layers[2];
  assert.equal(visible.kind, 'image');
  assert.equal(visible.textRaster, true);
  assert.equal(visible.absY, headline.absY);
  assert.equal(visible.width, headline.width);
  assert.equal(visible.opacity, .85);
  assert.equal(Buffer.from(visible.imageDataBase64, 'base64').toString(), 'opaque browser glyphs');
  console.log('PASS custom-font raster is visible to old plugins while editable text stays hidden');
})().catch(error => { console.error(error); process.exitCode = 1; });
