const assert = require('node:assert/strict');
const rendererPath = require.resolve('../api/render25');
const previous = require.cache[rendererPath];
require.cache[rendererPath] = {
  id: rendererPath,
  filename: rendererPath,
  loaded: true,
  exports: async (_req, res) => res.status(422).json({
    ok: false,
    code: 'SITE_CHALLENGE',
    error: 'Сайт показывает проверку Cloudflare',
  }),
};
const diagnose = require('../api/diagnose');
if (previous) require.cache[rendererPath] = previous;
else delete require.cache[rendererPath];

(async () => {
  let status = 200, body;
  const res = {
    setHeader() { return this; },
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };
  await diagnose({ method: 'GET', query: { url: 'https://nourvillasbelize.com/' } }, res);
  assert.equal(status, 422);
  assert.equal(body.code, 'SITE_CHALLENGE');
  assert.match(body.error, /Cloudflare/);
  console.log('PASS diagnostics preserve access challenge status and message');
})().catch(error => { console.error(error); process.exitCode = 1; });
