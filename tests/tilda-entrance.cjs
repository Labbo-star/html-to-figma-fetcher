const assert = require('node:assert/strict');
const vm = require('node:vm');
const { stabilizeTildaEntrances } = require('../lib/tilda-entrance');

function element(animation, options = {}) {
  const values = new Map();
  const node = {
    parentElement: options.parent || null,
    hidden: false,
    hiddenByAncestor: !!options.hiddenByAncestor,
    transform: options.transform || 'translateX(32px)',
    waiting: true,
    getAttribute(name) { return name === 'data-animate-style' ? animation : null; },
    setAttribute(name, value) { values.set(name, value); },
    closest() { return this.hiddenByAncestor ? {} : null; },
    classList: { remove: name => { if (name === 't-animate_wait') node.waiting = false; } },
    style: { setProperty: (name, value) => { if (name === 'opacity') node.opacity = value; } },
    values,
  };
  return node;
}

const parent = { hidden: false, getAttribute: () => null, parentElement: null, display: 'block', visibility: 'visible' };
const visible = element('fadeinup', { parent });
const popup = element('fadein', { parent, hiddenByAncestor: true });
const slider = element('fadein', { parent, hiddenByAncestor: true });
const scroll = element('scroll', { parent });
const hiddenParent = { ...parent, display: 'none' };
const hidden = element('fadein', { parent: hiddenParent });
const context = {
  document: {
    querySelector: () => ({}),
    querySelectorAll: () => [visible, popup, slider, scroll, hidden],
  },
  getComputedStyle: el => ({ display: el.display, visibility: el.visibility }),
};

const stats = vm.runInNewContext(`(${stabilizeTildaEntrances.toString()})()`, context);
assert.deepEqual(JSON.parse(JSON.stringify(stats)), { eligible: 4, revealed: 1, skipped: 3 });
assert.equal(visible.opacity, '1');
assert.equal(visible.waiting, false);
assert.equal(visible.transform, 'translateX(32px)');
assert.equal(visible.values.get('data-html2figma-entrance-finished'), '1');
for (const unchanged of [popup, slider, scroll, hidden]) {
  assert.equal(unchanged.waiting, true);
  assert.equal(unchanged.opacity, undefined);
}
console.log('PASS Tilda fade entrance restores content while retaining hidden UI and authored geometry');
