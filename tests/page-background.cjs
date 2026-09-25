const assert = require('node:assert/strict');
const { materializePageBackground } = require('../lib/page-background');

const fill = { kind: 'solid', color: { r: .97, g: .97, b: .97, a: 1 } };
const snapshot = { width: 1440, height: 8000, pageBackground: fill, layers: [] };
assert.equal(materializePageBackground(snapshot), 1);
assert.equal(snapshot.layers.length, 1);
assert.equal(snapshot.layers[0].name, '__html2figma_page_background__');
assert.equal(snapshot.layers[0].width, 1440);
assert.equal(snapshot.layers[0].height, 8000);
assert.deepEqual(snapshot.layers[0].fill, fill);
assert.ok(snapshot.layers[0].zIndex < -100000);
assert.equal(materializePageBackground(snapshot), 0);
assert.equal(snapshot.layers.length, 1);

const invalid = { width: 1440, height: 1000, pageBackground: null, layers: [] };
assert.equal(materializePageBackground(invalid), 0);
assert.equal(invalid.layers.length, 0);

console.log('PASS page background becomes one bottom snapshot layer without duplication');
