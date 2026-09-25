// Tilda Zero Block often uses webfonts unavailable in the Figma editor. Keep
// editable text and supply the browser-painted glyphs only as a visual fallback
// for large custom-font headings. The plugin shows this PNG if it substitutes
// the font; otherwise it uses the original text node.
const COMMON_FONTS = /^(?:Arial|Helvetica(?: Neue)?|Inter(?: Tight)?|Roboto|Open Sans|Verdana|Tahoma|Georgia|Times New Roman|sans-serif|serif|system-ui)$/i;
const MAX_CAPTURES = 48;

async function captureTildaHeadlines(page, snapshot) {
  const stats = { attempted: 0, captured: 0, errors: 0 };
  const viewport = page.viewport() || { width: snapshot.width, height: 1100 };
  const candidates = snapshot.layers.filter(layer => layer.kind === 'text' &&
    layer.textCaptureId && String(layer.text || '').trim() &&
    Number(layer.fontSize) >= 26 && !COMMON_FONTS.test(String(layer.fontFamily || '').trim()) &&
    layer.width > 3 && layer.height > 3 && layer.width < viewport.width - 2 &&
    layer.height < viewport.height - 2 && layer.width * layer.height < 450000);
  candidates.sort((a, b) => Number(b.fontSize || 0) - Number(a.fontSize || 0));
  for (const layer of candidates.slice(0, MAX_CAPTURES)) {
    stats.attempted++;
    try {
      const size = await page.evaluate(({ id, x, y, width, height }) => {
        const source = document.querySelector(`[data-html2figma-text-capture="${id}"]`);
        if (!(source instanceof HTMLElement) || document.getElementById('__h2f_text_overlay')) return null;
        const rect = source.getBoundingClientRect(), css = getComputedStyle(source);
        const scale = source.offsetWidth > 0 ? rect.width / source.offsetWidth : 1;
        if (!Number.isFinite(scale) || scale < .1 || scale > 8) return null;
        const overlay = document.createElement('div');
        overlay.id = '__h2f_text_overlay';
        overlay.style.cssText = 'position:fixed!important;left:0!important;top:0!important;z-index:2147483647!important;visibility:visible!important;opacity:1!important;pointer-events:none!important;background:transparent!important;';
        const copy = source.cloneNode(true);
        copy.removeAttribute('id');
        copy.removeAttribute('data-html2figma-text-capture');
        for (const prop of css) copy.style.setProperty(prop, css.getPropertyValue(prop), 'important');
        copy.style.setProperty('position', 'absolute', 'important');
        copy.style.setProperty('left', `${rect.left + scrollX - x}px`, 'important');
        copy.style.setProperty('top', `${rect.top + scrollY - y}px`, 'important');
        copy.style.setProperty('width', `${source.offsetWidth || rect.width}px`, 'important');
        copy.style.setProperty('height', `${source.offsetHeight || rect.height}px`, 'important');
        copy.style.setProperty('margin', '0', 'important');
        copy.style.setProperty('transform-origin', 'left top', 'important');
        copy.style.setProperty('transform', `scale(${scale})`, 'important');
        copy.style.setProperty('visibility', 'visible', 'important');
        copy.style.setProperty('opacity', '1', 'important');
        overlay.appendChild(copy);
        const hide = document.createElement('style');
        hide.id = '__h2f_text_hide';
        hide.textContent = 'html,body{background:transparent!important;background-image:none!important}body *{visibility:hidden!important}body > #__h2f_text_overlay,body > #__h2f_text_overlay *{visibility:visible!important}';
        document.body.appendChild(overlay);
        document.head.appendChild(hide);
        return { width: Math.ceil(width), height: Math.ceil(height) };
      }, { id: layer.textCaptureId, x: layer.absX, y: layer.absY, width: layer.width, height: layer.height });
      if (!size) continue;
      try {
        const png = await page.screenshot({ clip: { x: 0, y: 0, width: size.width, height: size.height }, omitBackground: true, timeout: 3500 });
        layer.fallbackImageDataBase64 = Buffer.from(png).toString('base64');
        layer.fallbackBounds = { absX: layer.absX, absY: layer.absY, width: layer.width, height: layer.height };
        stats.captured++;
      } finally {
        await page.evaluate(() => { document.getElementById('__h2f_text_hide')?.remove(); document.getElementById('__h2f_text_overlay')?.remove(); });
      }
    } catch {
      stats.errors++;
      await page.evaluate(() => { document.getElementById('__h2f_text_hide')?.remove(); document.getElementById('__h2f_text_overlay')?.remove(); }).catch(() => {});
      if (stats.errors >= 3) break;
    }
  }
  return stats;
}

module.exports = { captureTildaHeadlines };
