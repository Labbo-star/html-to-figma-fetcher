const assert = require('node:assert/strict');
const path = require('node:path');
const chromium = require('@sparticuz/chromium').default;
const { inflate } = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const sharp = require('sharp');
const { augmentElementorSnapshot } = require('../lib/elementor-fidelity');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: await inflate(path.resolve(__dirname, '../node_modules/@sparticuz/chromium/bin/chromium.br')),
    headless: true,
    args: [...chromium.args, '--disable-dev-shm-usage'],
    defaultViewport: { width: 1100, height: 900, deviceScaleFactor: 1 },
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>
        body { margin: 0; }
        #hero { margin: 40px 20px; width: 900px; height: 260px; border-radius: 24px;
          background: radial-gradient(circle at 15% 35%, #f20 0%, transparent 58%),
                      radial-gradient(circle at 80% 65%, #078cff 0%, transparent 65%), #fff; }
        #hero > div { width: 100%; height: 100%; background: #000; }
        #reviews { display: block; margin: 80px 20px; width: 900px; height: 300px; border: 0; }
      </style>
      <main class="elementor"><div id="hero"><div>Separate editable headline</div></div>
      <iframe id="reviews" srcdoc="<body style='background:white;font:24px sans-serif;color:#007bff'><article style='padding:24px;background:#dbeaff'>Customer review</article></body>"></iframe></main>`);
    const rects = await page.evaluate(() => Object.fromEntries(['hero', 'reviews'].map(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return [id, { x: r.x, y: r.y, width: r.width, height: r.height }];
    })));
    const snapshot = {
      width: 1100, height: 900, sections: [{ id: 'section-0', y: 0, height: 900 }],
      layers: [
        { kind: 'shape', name: 'hero — плашка', ...rects.hero, absX: rects.hero.x, absY: rects.hero.y, fill: { kind: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }, z: 1 },
        { kind: 'container', name: 'iframe#reviews — контейнер', ...rects.reviews, absX: rects.reviews.x, absY: rects.reviews.y, containerKey: 'iframe-0', sectionId: 'section-0', z: 2 },
      ],
    };
    const stats = await augmentElementorSnapshot(page, snapshot, snapshot.width);
    assert.equal(stats.radialBackgrounds, 1);
    assert.equal(stats.iframeCaptures, 1);
    const hero = snapshot.layers[0], review = snapshot.layers.at(-1);
    assert.equal(hero.kind, 'image');
    assert.equal(hero.fill, undefined);
    assert.equal(review.parentContainerKey, 'iframe-0');
    assert.equal(review.x, 0);
    assert.equal(review.y, 0);
    const pixel = await sharp(Buffer.from(hero.imageDataBase64, 'base64')).extract({ left: 450, top: 130, width: 1, height: 1 }).raw().toBuffer();
    assert.ok(pixel[0] + pixel[1] + pixel[2] > 100, 'hero text/black child must not be baked into the background');
    const metrics = await sharp(Buffer.from(review.imageDataBase64, 'base64')).stats();
    assert.ok(metrics.channels.some(ch => ch.stdev > 3), 'iframe capture must contain visible widget content');
    console.log('PASS radial background stays behind editable content; iframe widget is captured inside its frame');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
