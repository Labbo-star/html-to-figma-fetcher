const assert = require('node:assert/strict');
const vm = require('node:vm');
const { detectSiteChallenge } = require('../lib/site-challenge');

function run(title, body, selector = false) {
  return vm.runInNewContext(`(${detectSiteChallenge.toString()})()`, {
    document: { title, body: { innerText: body }, querySelector: () => selector ? {} : null },
  });
}
assert.equal(run('nourvillasbelize.com', 'Выполнение проверки безопасности. Этот веб-сайт использует сервис безопасности для защиты от вредоносных ботов. Эта страница отображается, пока веб-сайт проверяет, что вы не бот. Ray ID: a40d67859c65c890. Производительность и безопасность с Cloudflare.').blocked, true);
assert.equal(run('Just a moment...', 'Checking your browser. Cloudflare Ray ID: 123', true).blocked, true);
assert.equal(run('Cloudflare CDN explained', 'How Cloudflare protects my WordPress site. This long article discusses security checks.').blocked, false);
assert.equal(run('My studio', 'Welcome to our portfolio and projects.').blocked, false);
console.log('PASS access challenge is reported instead of imported as a fake site');
