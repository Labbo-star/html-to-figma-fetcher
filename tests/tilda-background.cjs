const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Execute the exact page-side helper with small DOM stand-ins.
const source = fs.readFileSync(require.resolve('../lib/render17'), 'utf8');
const start = source.indexOf('      const backgroundUrls = (e, backgroundImage) => {');
const end = source.indexOf('      const radius =', start);
assert(start > 0 && end > start);
const helper = vm.runInNewContext(`(() => {
  const urls = v => [...String(v).matchAll(/url\\(["']?([^"')]+)["']?\\)/gi)].map(m => m[1]);
  const fullTilda = v => v;
  ${source.slice(start, end)}
  return backgroundUrls;
})()`);
const optimized = 'https://static.tildacdn.com/test/center/center/photo.jpg.webp';
const original = 'https://static.tildacdn.com/test/photo.jpg';
const tilda = { classList: { contains: v => v === 't-bgimg' }, getAttribute: v => v === 'data-original' ? original : null };
const generic = { classList: { contains: () => false }, getAttribute: () => original };
assert.equal(helper(tilda, `url("${optimized}")`)[0], original);
assert.equal(helper(generic, `url("${optimized}")`)[0], optimized);
assert.equal(helper(tilda, 'none').length, 0);
assert.equal(helper({ ...tilda, getAttribute: () => null }, `url("${optimized}")`)[0], optimized);
console.log('PASS Tilda background uses authored full image while preserving generic CSS backgrounds');
