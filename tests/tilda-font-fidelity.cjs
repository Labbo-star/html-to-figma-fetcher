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
    fontFamily: 'DrukTextWideTT', fontSize: 136, width: 700, height: 200, absX: 10, absY: 5000 };
  const common = { ...headline, textCaptureId: 'txtcap-2', fontFamily: 'Inter' };
  const snapshot = { layers: [headline, common] };
  const stats = await captureTildaHeadlines(page, snapshot);
  assert.deepEqual(stats, { attempted: 1, captured: 1, errors: 0 });
  assert.deepEqual(events, [['mount', 'txtcap-1'], ['cleanup']]);
  assert.equal(Buffer.from(headline.fallbackImageDataBase64, 'base64').toString(), 'opaque browser glyphs');
  assert.deepEqual(headline.fallbackBounds, { absX: 10, absY: 5000, width: 700, height: 200 });
  assert.equal(common.fallbackImageDataBase64, undefined);
  console.log('PASS custom-font visual fallback is bounded and editable text remains');
})().catch(error => { console.error(error); process.exitCode = 1; });
