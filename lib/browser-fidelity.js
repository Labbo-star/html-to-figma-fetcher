'use strict';

async function collectBrowserFidelityFromPage(page) {
    return await page.evaluate(() => {
      const round = v => Math.round(v * 100) / 100;
      const num = (v, fallback = 0) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : fallback; };
      const cssColor = value => {
        const m = String(value || '').match(/rgba?\(([^)]+)\)/i);
        if (!m) return { r: 0, g: 0, b: 0, a: 0 };
        const p = m[1].split(',').map(x => Number.parseFloat(x.trim()));
        return {
          r: Math.max(0, Math.min(1, (p[0] || 0) / 255)),
          g: Math.max(0, Math.min(1, (p[1] || 0) / 255)),
          b: Math.max(0, Math.min(1, (p[2] || 0) / 255)),
          a: p.length > 3 && Number.isFinite(p[3]) ? Math.max(0, Math.min(1, p[3])) : 1,
        };
      };
      const visible = e => {
        if (!(e instanceof Element)) return false;
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        return r.width > .5 && r.height > .5 && s.display !== 'none' && s.visibility !== 'hidden' && num(s.opacity, 1) > .01;
      };
      const name = (e, suffix = '') => ((e.tagName || 'node').toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList && e.classList.length ? '.' + Array.from(e.classList).slice(0, 2).join('.') : '') + suffix).slice(0, 100);
      const rectBase = (e, s) => {
        const r = e.getBoundingClientRect();
        return {
          x: round(r.left + scrollX), y: round(r.top + scrollY),
          absX: round(r.left + scrollX), absY: round(r.top + scrollY),
          width: round(r.width), height: round(r.height), opacity: num(s.opacity, 1),
        };
      };
      const serializeSvg = svg => {
        const clone = svg.cloneNode(true);
        const source = [svg, ...svg.querySelectorAll('*')];
        const target = [clone, ...clone.querySelectorAll('*')];
        const props = ['color', 'fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'opacity', 'stop-color', 'stop-opacity', 'vector-effect'];
        for (let i = 0; i < Math.min(source.length, target.length); i++) {
          const s = getComputedStyle(source[i]);
          for (const prop of props) {
            const value = s.getPropertyValue(prop);
            if (!value || value === 'normal') continue;
            try { target[i].setAttribute(prop, value); } catch {}
          }
          try { target[i].removeAttribute('class'); } catch {}
        }
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        return clone.outerHTML;
      };

      const svgs = [];
      for (const svg of document.querySelectorAll('svg')) {
        if (svg.closest('svg svg') || !visible(svg)) continue;
        const s = getComputedStyle(svg), b = rectBase(svg, s);
        if (b.width > 5000 || b.height > 5000) continue;
        const serialized = serializeSvg(svg);
        if (serialized.length > 180000) continue;
        svgs.push({ kind: 'svg', name: name(svg), ...b, svg: serialized, zIndex: Number.parseInt(s.zIndex, 10) || 0, stackPath: [100], paintPhase: 2 });
        if (svgs.length >= 220) break;
      }

      const fixed = [];
      const fixedRoots = Array.from(document.querySelectorAll('body *')).filter(e => {
        if (!(e instanceof HTMLElement) || !visible(e)) return false;
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        return (s.position === 'fixed' || s.position === 'sticky') && r.bottom > 0 && r.top < Math.min(innerHeight, 320) && r.width > 80 && r.height > 12;
      }).slice(0, 12);
      const textSeen = new Set();
      for (const root of fixedRoots) {
        const rs = getComputedStyle(root), rb = rectBase(root, rs), bg = cssColor(rs.backgroundColor);
        if (bg.a > .01 && rb.width <= innerWidth * 1.2 && rb.height <= 400) {
          fixed.push({ kind: 'shape', name: name(root, ' — fixed фон'), ...rb, fill: { kind: 'solid', color: bg }, radius: num(rs.borderRadius), zIndex: 100000, stackPath: [100000], paintPhase: 0 });
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 220) continue;
          const el = node.parentElement;
          if (!el || !visible(el)) continue;
          const s = getComputedStyle(el), r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const key = text.toLowerCase() + '|' + Math.round(r.left) + '|' + Math.round(r.top);
          if (textSeen.has(key)) continue;
          textSeen.add(key);
          fixed.push({
            kind: 'text', name: name(el, ' — fixed текст'), x: round(r.left + scrollX), y: round(r.top + scrollY), absX: round(r.left + scrollX), absY: round(r.top + scrollY), width: round(r.width), height: round(r.height), opacity: num(s.opacity, 1), text,
            fontSize: num(s.fontSize, 16), fontWeight: num(s.fontWeight, 400), fontFamily: String(s.fontFamily || 'Inter').split(',')[0].replace(/["']/g, ''), fontStyle: s.fontStyle, lineHeight: num(s.lineHeight, num(s.fontSize, 16) * 1.2), letterSpacing: s.letterSpacing === 'normal' ? 0 : num(s.letterSpacing), textAlign: String(s.textAlign).toUpperCase() === 'CENTER' ? 'CENTER' : String(s.textAlign).toUpperCase() === 'RIGHT' ? 'RIGHT' : 'LEFT', fill: { kind: 'solid', color: cssColor(s.color) }, expectedLineCount: Math.max(1, Math.round(r.height / Math.max(1, num(s.lineHeight, num(s.fontSize, 16) * 1.2)))), textSizing: 'FIXED', zIndex: 100001, stackPath: [100000], paintPhase: 2,
          });
          if (fixed.length >= 160) break;
        }
        if (fixed.length >= 160) break;
      }

      const pseudos = [];
      const elements = Array.from(document.querySelectorAll('body *')).slice(0, 1800);
      for (const el of elements) {
        if (!(el instanceof HTMLElement) || !visible(el)) continue;
        const er = el.getBoundingClientRect();
        for (const pseudo of ['::before', '::after']) {
          const s = getComputedStyle(el, pseudo);
          if (!s || s.display === 'none' || s.visibility === 'hidden' || num(s.opacity, 1) <= .01) continue;
          const rawContent = String(s.content || '');
          const content = rawContent && rawContent !== 'none' && rawContent !== 'normal' ? rawContent.replace(/^['"]|['"]$/g, '') : '';
          const bg = cssColor(s.backgroundColor), borderWidth = Math.max(num(s.borderTopWidth), num(s.borderRightWidth), num(s.borderBottomWidth), num(s.borderLeftWidth));
          const hasVisual = bg.a > .01 || s.backgroundImage !== 'none' || borderWidth > .1 || (content && content !== '""' && content !== "''");
          if (!hasVisual) continue;
          if (!['absolute', 'fixed'].includes(s.position)) continue;
          const w = num(s.width), h = num(s.height);
          if (w < .5 || h < .5 || w > 1200 || h > 1200) continue;
          const left = s.left !== 'auto' ? num(s.left) : null, right = s.right !== 'auto' ? num(s.right) : null, top = s.top !== 'auto' ? num(s.top) : null, bottom = s.bottom !== 'auto' ? num(s.bottom) : null;
          const x = s.position === 'fixed' ? (left != null ? left : right != null ? innerWidth - right - w : er.left) : er.left + (left != null ? left : right != null ? er.width - right - w : 0);
          const y = s.position === 'fixed' ? (top != null ? top : bottom != null ? innerHeight - bottom - h : er.top) : er.top + (top != null ? top : bottom != null ? er.height - bottom - h : 0);
          const base = { x: round(x + scrollX), y: round(y + scrollY), absX: round(x + scrollX), absY: round(y + scrollY), width: round(w), height: round(h), opacity: num(s.opacity, 1), zIndex: Number.parseInt(s.zIndex, 10) || 0, stackPath: [50], paintPhase: 2 };
          if (bg.a > .01 || borderWidth > .1) {
            pseudos.push({ kind: 'shape', name: name(el, ' ' + pseudo), ...base, fill: bg.a > .01 ? { kind: 'solid', color: bg } : undefined, stroke: borderWidth > .1 ? cssColor(s.borderTopColor) : undefined, strokeWeight: borderWidth > .1 ? borderWidth : undefined, radius: num(s.borderRadius) });
          }
          if (content && content !== '""' && content !== "''" && !/^url\(/i.test(content)) {
            pseudos.push({ kind: 'text', name: name(el, ' ' + pseudo + ' — текст'), ...base, text: content, fontSize: num(s.fontSize, 16), fontWeight: num(s.fontWeight, 400), fontFamily: String(s.fontFamily || 'Inter').split(',')[0].replace(/["']/g, ''), fontStyle: s.fontStyle, lineHeight: num(s.lineHeight, num(s.fontSize, 16) * 1.2), letterSpacing: s.letterSpacing === 'normal' ? 0 : num(s.letterSpacing), textAlign: 'CENTER', fill: { kind: 'solid', color: cssColor(s.color) }, expectedLineCount: 1, textSizing: 'FIXED' });
          }
          if (pseudos.length >= 160) break;
        }
        if (pseudos.length >= 160) break;
      }
      return { svgs, fixed, pseudos };
    });
}

module.exports = { collectBrowserFidelityFromPage };
