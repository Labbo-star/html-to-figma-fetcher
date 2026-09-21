const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Keep the proven Tilda/generic renderer untouched on disk. For this public
// route we compile a narrowly patched copy of v17 in memory: the extra work is
// gated by positive Elementor detection and runs BEFORE v17 freezes sliders
// and extracts geometry. This avoids the old v22 strategy of trying to rebuild
// missing Elementor fragments after the snapshot already existed.
function compilePatchedModule(filename, transform) {
  const source = fs.readFileSync(filename, 'utf8');
  const patched = transform(source);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(patched, filename);
  mod.loaded = true;
  return mod;
}

const corePath = require.resolve('../lib/render17');
const coreModule = compilePatchedModule(corePath, source => {
  const marker = "    stage = 'фиксация первоначального состояния';\n    await prepare();";
  if (!source.includes(marker)) throw new Error('render17 preflight marker not found');

  const preflight = String.raw`    let elementorPreflight = null;
    try {
      const isElementor = await page.evaluate(() => {
        const body = document.body;
        const generator = document.querySelector('meta[name="generator"]')?.getAttribute('content') || '';
        return !!(
          (body && body.classList && body.classList.contains('elementor-page')) ||
          document.querySelector('[data-elementor-id],.elementor') ||
          /elementor/i.test(generator)
        );
      });

      if (isElementor) {
        stage = 'Elementor preflight';
        elementorPreflight = await page.evaluate(async maxHeight => {
          const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
          const root = document.scrollingElement || document.documentElement;
          const maxScroll = Math.min(maxHeight, Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0, 1));

          // First let Elementor/Swiper/IntersectionObserver see every viewport.
          // This is intentionally done before animations are frozen by v17.
          for (let y = 0; y < maxScroll; y += 720) {
            window.scrollTo(0, y);
            window.dispatchEvent(new Event('scroll'));
            await sleep(105);
          }
          window.scrollTo(0, 0);
          window.dispatchEvent(new Event('scroll'));
          window.dispatchEvent(new Event('resize'));
          await sleep(220);

          let revealed = 0;
          let lazyResolved = 0;
          let entranceTransformsCleared = 0;
          const candidates = new Set(Array.from(document.querySelectorAll('.elementor-invisible')));
          for (const el of document.querySelectorAll('[data-settings]')) {
            const settings = String(el.getAttribute('data-settings') || '');
            if (/[_-]?animation/i.test(settings)) candidates.add(el);
          }

          const entranceRe = /(?:^|\s)(?:fadeIn|fadeInUp|fadeInDown|fadeInLeft|fadeInRight|zoomIn|zoomInUp|zoomInDown|zoomInLeft|zoomInRight|slideInUp|slideInDown|slideInLeft|slideInRight|bounceIn|bounceInUp|bounceInDown|bounceInLeft|bounceInRight|rotateIn|rotateInUpLeft|rotateInUpRight|rotateInDownLeft|rotateInDownRight|lightSpeedIn|rollIn|jackInTheBox)(?:\s|$)/i;

          for (const el of candidates) {
            if (!(el instanceof HTMLElement)) continue;
            const cs = getComputedStyle(el);
            const hiddenByEntrance = el.classList.contains('elementor-invisible') || cs.visibility === 'hidden' || Number.parseFloat(cs.opacity || '1') <= 0.01;
            if (!hiddenByEntrance) continue;

            const cls = String(el.className || '');
            el.classList.remove('elementor-invisible');
            el.setAttribute('data-h2f-elementor-reveal', '1');
            el.style.setProperty('visibility', 'visible', 'important');
            el.style.setProperty('opacity', '1', 'important');
            el.style.setProperty('animation', 'none', 'important');
            if (entranceRe.test(cls)) {
              el.setAttribute('data-h2f-elementor-entrance', '1');
              el.style.setProperty('transform', 'none', 'important');
              entranceTransformsCleared++;
            }
            revealed++;
          }

          for (const img of document.querySelectorAll('img')) {
            const src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-lazyload') || img.getAttribute('data-original');
            if (src && img.src !== src) {
              try { img.src = src; lazyResolved++; } catch {}
            }
            const srcset = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
            if (srcset && img.getAttribute('srcset') !== srcset) {
              try { img.setAttribute('srcset', srcset); lazyResolved++; } catch {}
            }
            try { img.loading = 'eager'; } catch {}
          }

          for (const source of document.querySelectorAll('source[data-srcset],source[data-lazy-srcset]')) {
            const srcset = source.getAttribute('data-srcset') || source.getAttribute('data-lazy-srcset');
            if (srcset) {
              try { source.setAttribute('srcset', srcset); lazyResolved++; } catch {}
            }
          }

          for (const el of document.querySelectorAll('[data-bg],[data-background-image],[data-lazy-bg],[data-bg-url],[data-e-bg-lazyload],.e-lazyload')) {
            if (!(el instanceof HTMLElement)) continue;
            el.classList.remove('e-lazyload');
            el.classList.add('e-lazyloaded');
            const raw = el.getAttribute('data-bg') || el.getAttribute('data-background-image') || el.getAttribute('data-lazy-bg') || el.getAttribute('data-bg-url') || el.getAttribute('data-e-bg-lazyload');
            if (!raw) continue;
            let value = String(raw).trim();
            const match = value.match(/url\((?:"|')?([^"')]+)(?:"|')?\)/i);
            if (match) value = match[1];
            if (/^(?:https?:|\/\/|\/|\.\/|\.\.\/)/i.test(value)) {
              try {
                const absolute = new URL(value, location.href).href;
                el.style.setProperty('background-image', 'url("' + absolute.replace(/"/g, '') + '")', 'important');
                lazyResolved++;
              } catch {}
            }
          }

          let style = document.getElementById('__h2f_elementor_preflight');
          if (!style) {
            style = document.createElement('style');
            style.id = '__h2f_elementor_preflight';
            document.head.appendChild(style);
          }
          style.textContent = '[data-h2f-elementor-reveal="1"]{visibility:visible!important;opacity:1!important;animation:none!important;animation-delay:0s!important;animation-duration:0s!important}[data-h2f-elementor-entrance="1"]{transform:none!important}';

          window.dispatchEvent(new Event('resize'));
          window.dispatchEvent(new Event('scroll'));
          await sleep(280);
          return { detected: true, revealed, lazyResolved, entranceTransformsCleared };
        }, MAX_HEIGHT);

        await Promise.race([
          page.waitForNetworkIdle({ idleTime: 250, timeout: 1800 }).catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 1800)),
        ]);
        await Promise.race([
          page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 1200)),
        ]);
      }
    } catch (error) {
      elementorPreflight = { detected: true, error: error && error.message ? error.message : String(error) };
    }

${marker}`;

  let patched = source.replace(marker, preflight);
  const snapshotMarker = "    if (!snapshot.layers.length) throw new Error('После рендера не найдено видимых слоёв');";
  if (!patched.includes(snapshotMarker)) throw new Error('render17 snapshot marker not found');
  patched = patched.replace(
    snapshotMarker,
    "    if (elementorPreflight && elementorPreflight.detected) snapshot.elementorPreflight = elementorPreflight;\n" + snapshotMarker
  );
  return patched;
});
require.cache[corePath] = coreModule;

// v22 used a second Chromium pass to append isolated hidden Elementor nodes.
// Once the full page is revealed before v17 extraction that supplement becomes
// harmful (duplicates/fragments), so skip it only when the preflight marker is
// present. Tilda and generic behavior remains exactly on the existing path.
const v22Path = require.resolve('../lib/render22');
const v22Module = compilePatchedModule(v22Path, source => {
  const marker = "    if (framework === 'elementor') {";
  if (!source.includes(marker)) throw new Error('render22 Elementor marker not found');
  let patched = source.replace(marker, "    if (framework === 'elementor' && !(snapshot.elementorPreflight && snapshot.elementorPreflight.detected)) {");
  const statsMarker = '        elementorSupplementLayers: revealed.layers.length,';
  if (patched.includes(statsMarker)) {
    patched = patched.replace(statsMarker, statsMarker + "\n        elementorPreflight: snapshot.elementorPreflight || null,");
  }
  return patched;
});
require.cache[v22Path] = v22Module;

module.exports = require('../lib/render24');
