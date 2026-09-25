#!/usr/bin/env node
// Run the actual renderer on public sites and record import diagnostics without Figma.
// Example: node scripts/benchmark.cjs --base https://html-to-figma-fetcher-v2.vercel.app --sites outmeet,rocketway --repeat 2
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const manifest = require('./benchmark-sites.json');
const args = process.argv.slice(2);
function option(key, fallback) { const i = args.indexOf('--' + key); return i >= 0 ? args[i + 1] : fallback; }
const base = option('base', 'https://html-to-figma-fetcher-v2.vercel.app').replace(/\/+$/, '');
const sites = option('sites', '').split(',').filter(Boolean);
const repetitions = Math.max(1, Math.min(5, Number(option('repeat', '1')) || 1));
const width = Math.max(320, Math.min(1920, Number(option('width', '1440')) || 1440));
const outDir = path.resolve(option('out', path.join(os.tmpdir(), 'html2figma-benchmark')));
const cookie = option('cookie', '');
const selected = manifest.filter(item => !sites.length || sites.includes(item.id));
if (sites.some(id => !manifest.some(item => item.id === id))) throw Error('Unknown site ID: ' + sites.filter(id => !manifest.some(item => item.id === id)).join(', '));
fs.mkdirSync(outDir, { recursive: true });

async function diagnose(site, run) {
  const started = Date.now();
  const outfile = path.join(outDir, `${site.id}-${width}-${run}.json`);
  const url = `${base}/api/diagnose`;
  const cmd = ['-sS', '-G', '--max-time', '115', '--data-urlencode', 'url=' + site.url,
    '--data-urlencode', 'width=' + width, '-o', outfile, '-w', '%{http_code}', url];
  if (cookie) cmd.unshift('-b', cookie);
  const { status, error } = await new Promise(resolve => {
    let out = '', err = '';
    const p = spawn('curl', cmd);
    p.stdout.on('data', b => { out += b; });
    p.stderr.on('data', b => { err += b; });
    p.on('error', e => resolve({ status: 'spawn-error', error: e.message }));
    p.on('close', code => resolve({ status: out.trim(), error: code === 0 ? '' : err.trim().slice(0, 300) }));
  });
  const result = { site: site.id, url: site.url, run, width, elapsedMs: Date.now() - started, httpStatus: status };
  try {
    const response = JSON.parse(fs.readFileSync(outfile, 'utf8'));
    const snap = response.snapshot || {}, stats = response.stats || {};
    Object.assign(result, {
      ok: status === '200' && response.ok === true && response.rendererStatus === true,
      framework: snap.framework || stats.framework,
      frameworkMatches: snap.framework === site.expectedFramework,
      layers: snap.layers || 0, sections: snap.sections || 0,
      images: snap.images?.total || 0, texts: snap.byKind?.text || 0,
      height: snap.height || 0, truncated: !!snap.truncated,
      fidelityPass: stats.fidelityPass || '',
      tildaEntrances: stats.tildaEntrances || null,
      source: outfile,
    });
    result.checks = Object.entries(site.minimum || {}).filter(([field, min]) => (result[field] || 0) < min).map(([field]) => field);
    // A browser screenshot can contain an image whose serialized URL is a
    // transient optimization address. The Figma plugin then sees a 404.
    result.transientImageUrls = (snap.images?.samples || [])
      .map(image => image.url || image.sourceUrl)
      .filter(url => /\/center\/center\/[^/]+\.jpe?g\.webp(?:[?#]|$)/i.test(String(url || '')));
    if (result.transientImageUrls.length) result.checks.push('transient-image-url');
    if (!result.frameworkMatches) result.checks.push('framework');
    if (result.truncated) result.checks.push('truncated');
    if (result.fidelityPass.startsWith('degraded')) result.checks.push('fidelityPass');
    if (!result.ok) result.checks.push('http');
  } catch (e) {
    result.ok = false;
    result.error = error || e.message;
    result.checks = ['http'];
  }
  console.log(`${result.checks.length ? 'FAIL' : 'PASS'} ${site.id} #${run} ${result.elapsedMs}ms layers=${result.layers ?? '-'} images=${result.images ?? '-'} issues=${result.checks.join(',') || '-'}${result.error ? ' error=' + result.error : ''}`);
  return result;
}

(async () => {
  const results = [];
  // Sequential runs deliberately expose flaky pages while avoiding overload.
  for (const site of selected) for (let run = 1; run <= repetitions; run++) results.push(await diagnose(site, run));
  const report = {
    generatedAt: new Date().toISOString(), base, width,
    results,
    summary: { total: results.length, passed: results.filter(r => !r.checks.length).length,
      failed: results.filter(r => r.checks.length).length },
  };
  fs.writeFileSync(path.join(outDir, `summary-${width}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary));
  if (report.summary.failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 2; });
