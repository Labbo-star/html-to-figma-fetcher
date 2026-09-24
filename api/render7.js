const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Keep the proven Tilda/generic renderer untouched on disk. For this public
// route we compile a narrowly patched copy of v17 in memory. All extra work is
// gated by positive Elementor detection, so Tilda continues through the proven
// v17 path without Elementor geometry/reveal mutations.
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

// Runs only in a browser page positively identified as Bricks.
async function prepareBricksPage(finalize) {
  if (!document.body || !document.body.classList.contains('bricks-is-frontend') || !document.querySelector('#brx-content')) return null;
  const root = document.querySelector('#brx-content');
  const excluded = '[hidden],[aria-hidden="true"],.brx-popup,[role="dialog"],dialog,.swiper-slide:not(.swiper-slide-active),.splide__slide:not(.is-active)';
  const allowed = el => el instanceof HTMLElement && root.contains(el) && !el.closest(excluded) && getComputedStyle(el).display !== 'none';
  const stats = { detected:true, finalized:!!finalize, revealed:0, finished:0, serviceTextHidden:0 };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // ScrollSmoother translates a wrapper; measuring while it catches up loses
  // off-screen reveal states and shifts absolute coordinates.
  if (!finalize) {
    const smoother = window.ScrollSmoother && window.ScrollSmoother.get && window.ScrollSmoother.get();
    if (smoother) { smoother.scrollTop(0); smoother.kill(); }
    const max = Math.min(60000, Math.max(document.documentElement.scrollHeight,document.body.scrollHeight));
    const step = Math.max(650,Math.ceil(max/36));
    for(let y=0;y<max;y+=step){window.scrollTo(0,y);window.dispatchEvent(new Event('scroll'));if(window.ScrollTrigger)window.ScrollTrigger.update();await sleep(110);}
    window.scrollTo(0,0);window.dispatchEvent(new Event('scroll'));await sleep(150);
  }
  // SplitText hides visual word wrappers from assistive technology because
  // their parent supplies aria-label. That is not visual invisibility.
  for(const word of root.querySelectorAll('.anim-text .brf-split[aria-hidden="true"]')) {
    if(word.parentElement && !word.parentElement.closest(excluded))word.removeAttribute('aria-hidden');
  }
  const marked = new Set();
  if (window.ScrollTrigger && window.ScrollTrigger.getAll) {
    for(const trigger of window.ScrollTrigger.getAll()) {
      const animation=trigger.animation;
      if(!animation || !allowed(trigger.trigger)) continue;
      const tweens=animation.getChildren?animation.getChildren(true,true,false):[animation];
      const targets=tweens.flatMap(t=>t.targets?t.targets():[]).filter(t=>t instanceof HTMLElement);
      if(!targets.length || targets.some(t=>!allowed(t)))continue;
      // Only entrance opacity effects: never finish a carousel or an unrelated
      // pinning/position-only timeline merely because it uses ScrollTrigger.
      if(!targets.every(t=>t.matches('.anim-opacity,.brf-split-words,.brf-split-chars,.brf-split-lines') || t.closest('.anim-text')))continue;
      if(animation.repeat && animation.repeat()===-1)continue;
      try{if(finalize)trigger.kill(false,true);animation.progress(1,true).pause();stats.finished++;targets.forEach(t=>marked.add(t));}catch{}
    }
  }
  for(const el of root.querySelectorAll('.anim-opacity,.anim-text .brf-split-words,.anim-text .brf-split-chars,.anim-text .brf-split-lines'))if(allowed(el))marked.add(el);
  for(const el of marked){
    // Do not reveal elements hidden by a popup/tab ancestor.
    let blocked=false;for(let n=el.parentElement;n&&n!==root;n=n.parentElement){const cs=getComputedStyle(n);if(cs.display==='none'||cs.visibility==='hidden'){blocked=true;break;}}
    if(blocked)continue;
    el.style.setProperty('opacity','1','important');el.style.setProperty('visibility','visible','important');el.setAttribute('data-h2f-bricks-reveal','1');stats.revealed++;
  }
  for(const el of document.querySelectorAll('.skip-link,.screen-reader-text,.sr-only')){
    const cs=getComputedStyle(el),values=(cs.clip.match(/-?[\d.]+/g)||[]).map(Number);
    const emptyClip=values.length===4&&(values[2]<=values[0]||values[1]<=values[3]);
    if(emptyClip || /inset\(50%/.test(cs.clipPath)){el.style.setProperty('display','none','important');stats.serviceTextHidden++;}
  }
  return stats;
}

const corePath = require.resolve('../lib/render17');
const coreModule = compilePatchedModule(corePath, source => {
  const marker = "    stage = 'фиксация первоначального состояния';\n    await prepare();";
  if (!source.includes(marker)) throw new Error('render17 preflight marker not found');

  const preflight = String.raw`    let elementorPreflight = null;
    const reassertElementor = async phase => {
      if (!(elementorPreflight && elementorPreflight.detected)) return null;
      return page.evaluate(currentPhase => {
        const stats = { phase: currentPhase, reasserted: 0, swiperActiveRestored: 0 };
        const marked = document.querySelectorAll('[data-h2f-elementor-reveal="1"]');
        for (const el of marked) {
          if (!(el instanceof HTMLElement)) continue;
          el.classList.remove('elementor-invisible');
          el.style.setProperty('visibility', 'visible', 'important');
          el.style.setProperty('opacity', '1', 'important');
          el.style.setProperty('animation', 'none', 'important');
          el.style.setProperty('animation-delay', '0s', 'important');
          el.style.setProperty('animation-duration', '0s', 'important');
          stats.reasserted++;
        }
        for (const slide of document.querySelectorAll('.swiper-slide-active,.swiper-slide-duplicate-active')) {
          if (!(slide instanceof HTMLElement)) continue;
          if (slide.getAttribute('aria-hidden') === 'true') slide.setAttribute('aria-hidden', 'false');
          slide.style.setProperty('visibility', 'visible', 'important');
          slide.style.setProperty('opacity', '1', 'important');
          stats.swiperActiveRestored++;
        }
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('scroll'));
        return stats;
      }, phase).catch(() => null);
    };

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
          const inElementor = el => !!(el && el.closest && el.closest('.elementor,[data-elementor-id],[data-elementor-type]'));

          // Let IntersectionObserver, Elementor entrance effects, lazy media and
          // Swiper see every viewport before the generic renderer freezes state.
          for (let y = 0; y < maxScroll; y += 640) {
            window.scrollTo(0, y);
            window.dispatchEvent(new Event('scroll'));
            await sleep(120);
          }
          window.scrollTo(0, 0);
          window.dispatchEvent(new Event('scroll'));
          window.dispatchEvent(new Event('resize'));
          await sleep(260);

          let animationsFinished = 0;
          let animationTargets = 0;
          let revealed = 0;
          let lazyResolved = 0;
          let swiperActiveRestored = 0;

          // Finish only finite one-shot animations whose effect target belongs
          // to Elementor. This preserves the element's real final transform
          // instead of blindly clearing transform on every animated node.
          try {
            for (const animation of document.getAnimations ? document.getAnimations() : []) {
              const effect = animation && animation.effect;
              const target = effect && effect.target;
              if (!(target instanceof Element) || !inElementor(target)) continue;
              let timing = null;
              try { timing = effect.getComputedTiming ? effect.getComputedTiming() : null; } catch {}
              const iterations = timing && Number.isFinite(timing.iterations) ? timing.iterations : 1;
              const duration = timing && Number.isFinite(timing.duration) ? timing.duration : 0;
              if (!Number.isFinite(iterations) || iterations > 3 || !Number.isFinite(duration) || duration > 15000) continue;
              animationTargets++;
              try {
                animation.finish();
                animationsFinished++;
              } catch {
                try {
                  if (effect && effect.getTiming) {
                    const raw = effect.getTiming();
                    const end = Number(raw.delay || 0) + Number(raw.duration || 0) * Math.max(1, Number(raw.iterations || 1));
                    if (Number.isFinite(end)) animation.currentTime = end;
                  }
                } catch {}
              }
            }
          } catch {}
          await sleep(80);

          const candidates = new Set();
          for (const el of document.querySelectorAll('.elementor-invisible,.animated,[data-settings],[class*="elementor-motion"],[class*="elementor-animation"]')) {
            if (inElementor(el)) candidates.add(el);
          }

          for (const el of candidates) {
            if (!(el instanceof HTMLElement)) continue;
            const cs = getComputedStyle(el);
            const settings = String(el.getAttribute('data-settings') || '');
            const cls = String(el.className || '');
            const entranceCandidate = el.classList.contains('elementor-invisible') ||
              /(?:^|\s)animated(?:\s|$)/i.test(cls) ||
              /(?:^|[_-])animation/i.test(settings) ||
              /elementor-(?:motion|animation)/i.test(cls);
            if (!entranceCandidate) continue;

            const hidden = cs.visibility === 'hidden' || Number.parseFloat(cs.opacity || '1') <= 0.01 || el.classList.contains('elementor-invisible');
            if (!hidden) continue;

            el.classList.remove('elementor-invisible');
            el.setAttribute('data-h2f-elementor-reveal', '1');
            el.style.setProperty('visibility', 'visible', 'important');
            el.style.setProperty('opacity', '1', 'important');
            el.style.setProperty('animation', 'none', 'important');
            el.style.setProperty('animation-delay', '0s', 'important');
            el.style.setProperty('animation-duration', '0s', 'important');
            // Do not overwrite transform here: after animation.finish() it is
            // either the genuine final transform or a meaningful design transform.
            revealed++;
          }

          // Preserve the actual initial/active Swiper slide only. Do not expose
          // every slide, which would destroy carousel geometry.
          for (const slide of document.querySelectorAll('.swiper-slide-active,.swiper-slide-duplicate-active')) {
            if (!(slide instanceof HTMLElement) || !inElementor(slide)) continue;
            if (slide.getAttribute('aria-hidden') === 'true') slide.setAttribute('aria-hidden', 'false');
            slide.style.setProperty('visibility', 'visible', 'important');
            slide.style.setProperty('opacity', '1', 'important');
            swiperActiveRestored++;
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
          style.textContent = '[data-h2f-elementor-reveal="1"]{visibility:visible!important;opacity:1!important;animation:none!important;animation-delay:0s!important;animation-duration:0s!important}.swiper-slide-active[data-h2f-elementor-reveal="1"]{visibility:visible!important;opacity:1!important}';

          window.dispatchEvent(new Event('resize'));
          window.dispatchEvent(new Event('scroll'));
          await sleep(320);
          return {
            detected: true,
            animationTargets,
            animationsFinished,
            revealed,
            lazyResolved,
            swiperActiveRestored
          };
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

${marker}
    if (elementorPreflight && elementorPreflight.detected) {
      const afterPrepare = await reassertElementor('after-initial-prepare');
      if (afterPrepare) elementorPreflight.afterPrepare = afterPrepare;
    }`;

  let patched = source.replace(marker, preflight);

  // prepare() runs again after v17's generic lazy-load sweep. Reassert only the
  // Elementor nodes marked by the preflight so the generic slider freeze cannot
  // hide them again. Non-Elementor pages never enter this branch.
  const repeatPrepare = "    stage = 'повторная фиксация';\n    await prepare();";
  if (!patched.includes(repeatPrepare)) throw new Error('render17 repeat prepare marker not found');
  patched = patched.replace(repeatPrepare, repeatPrepare + String.raw`
    if (elementorPreflight && elementorPreflight.detected) {
      const afterLazyPrepare = await reassertElementor('after-lazy-prepare');
      if (afterLazyPrepare) elementorPreflight.afterLazyPrepare = afterLazyPrepare;
      await new Promise(resolve => setTimeout(resolve, 120));
    }`);

  // v17 deliberately uses Tilda-centric section roots. Elementor builds its
  // visual page from top-level e-con / top-section nodes nested below the
  // Elementor root, so v17 collapses the whole page into one or two giant
  // sections. Patch only the in-memory Elementor snapshot path; the original
  // Tilda selector and section ownership logic remain byte-for-byte active for
  // every non-Elementor page.
  const sectionLoop = "      for (const e of doc.querySelectorAll('#allrecords > .t-rec,.t-rec[id],header,main > section,footer')) {";
  if (!patched.includes(sectionLoop)) throw new Error('render17 section loop marker not found');
  patched = patched.replace(sectionLoop, String.raw`      const elementorSnapshot = !!(
        (doc.body && doc.body.classList && doc.body.classList.contains('elementor-page')) ||
        doc.querySelector('[data-elementor-id],.elementor')
      );
      const sectionCandidates = elementorSnapshot
        ? (() => {
            const raw = Array.from(doc.querySelectorAll([
              '[data-elementor-type="header"]',
              'header',
              '.elementor[data-elementor-id] > .e-con.e-parent',
              '.elementor[data-elementor-id] > .elementor-element.e-con',
              '.elementor[data-elementor-id] > .elementor-top-section',
              '.elementor[data-elementor-id] > .elementor-section.elementor-top-section',
              'main > .e-con.e-parent',
              'main > .elementor-section',
              '[data-elementor-type="footer"]',
              'footer'
            ].join(',')));
            const candidateSet = new Set(raw);
            return raw.filter(el => {
              for (let p = el.parentElement; p && p !== doc.body; p = p.parentElement) {
                if (candidateSet.has(p) && !p.matches('header,footer,[data-elementor-type="header"],[data-elementor-type="footer"]')) return false;
              }
              return true;
            }).sort((a, b) => {
              const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
              return (ar.top + win.scrollY) - (br.top + win.scrollY) || ar.left - br.left;
            });
          })()
        : Array.from(doc.querySelectorAll('#allrecords > .t-rec,.t-rec[id],header,main > section,footer'));
      for (const e of sectionCandidates) {`);

  const sectionOwner = "        const c = e.closest ? e.closest('.t-rec,header,section,footer') : null;";
  if (!patched.includes(sectionOwner)) throw new Error('render17 section owner marker not found');
  patched = patched.replace(sectionOwner, "        const c = e.closest ? e.closest(elementorSnapshot ? '.e-con.e-parent,.elementor-top-section,.elementor-section.elementor-top-section,[data-elementor-type=\"header\"],[data-elementor-type=\"footer\"],header,footer' : '.t-rec,header,section,footer') : null;");

  const snapshotMarker = "    if (!snapshot.layers.length) throw new Error('После рендера не найдено видимых слоёв');";
  if (!patched.includes(snapshotMarker)) throw new Error('render17 snapshot marker not found');
  patched = patched.replace(
    snapshotMarker,
    String.raw`    if (elementorPreflight && elementorPreflight.detected) {
      snapshot.elementorPreflight = elementorPreflight;
      try {
        const { augmentElementorSnapshot } = require('./elementor-fidelity');
        snapshot.elementorFidelity = await augmentElementorSnapshot(page, snapshot, width);
      } catch (error) {
        snapshot.elementorFidelity = { error: error && error.message ? error.message : String(error) };
      }
    }
` + snapshotMarker
  );
  const bricksStart = "    stage = 'фиксация первоначального состояния';";
  patched = patched.replace(bricksStart, "    let bricksPreflight = await page.evaluate(" + prepareBricksPage.toString() + ", false);\n" + bricksStart);
  const bricksEnd = "    stage = 'снятие геометрии';";
  if (!patched.includes(bricksEnd)) throw new Error('render17 geometry marker not found');
  patched = patched.replace(bricksEnd, "    if (bricksPreflight) bricksPreflight.final = await page.evaluate(" + prepareBricksPage.toString() + ", true);\n" + bricksEnd);
  patched = patched.replace(snapshotMarker, "    if (bricksPreflight) snapshot.bricksPreflight = bricksPreflight;\n" + snapshotMarker);
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
    patched = patched.replace(statsMarker, statsMarker + "\n        elementorPreflight: snapshot.elementorPreflight || null,\n        elementorFidelity: snapshot.elementorFidelity || null,");
  }
  patched = patched.replace('const framework = frameworkOf(snapshot);', "const framework = snapshot.bricksPreflight ? 'bricks' : frameworkOf(snapshot);");
  patched = patched.replace(statsMarker, statsMarker + "\n        bricksPreflight: snapshot.bricksPreflight || null,");
  return patched;
});
require.cache[v22Path] = v22Module;

module.exports = require('../lib/render24');