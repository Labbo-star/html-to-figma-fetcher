const assert = require('node:assert/strict');

const corePath = require.resolve('../lib/render23');
const originalCore = require.cache[corePath];
require.cache[corePath] = {
  id: corePath,
  filename: corePath,
  loaded: true,
  exports: async (_req, res) => res.status(200).json({
    ok: true,
    snapshot: {
      width: 1440,
      height: 900,
      sections: [{ id: 'hero', y: 0, height: 900 }],
      layers: [{ kind: 'text', name: 'Title', text: 'Test', absX: 50, absY: 70, width: 150, height: 30 }],
      _fidelitySupplement: {
        svgs: [{ kind: 'svg', name: 'Icon', absX: 300, absY: 80, width: 24, height: 24, svg: '<svg><path fill="red"/></svg>' }],
        fixed: [],
        pseudos: [],
      },
    },
  }),
};

const render = require('../lib/render24');
if (originalCore) require.cache[corePath] = originalCore;
else delete require.cache[corePath];

(async () => {
  let status = 200, response;
  const res = {
    setHeader() { return this; },
    status(value) { status = value; return this; },
    json(value) { response = value; return this; },
  };
  await render({ method: 'GET', query: { url: 'https://unavailable.example.invalid/' } }, res);
  assert.equal(status, 200);
  assert.equal(response.stats.fidelityPass, 'same-browser');
  assert.equal(response.snapshot.layers.filter(layer => layer.kind === 'svg').length, 1);
  assert.equal(response.snapshot._fidelitySupplement, undefined);
  assert.equal(response.snapshot.layers.find(layer => layer.kind === 'svg').sectionId, 'hero');
  console.log('PASS same-browser supplement merges without opening the unavailable URL again');
})().catch(error => { console.error(error); process.exitCode = 1; });
