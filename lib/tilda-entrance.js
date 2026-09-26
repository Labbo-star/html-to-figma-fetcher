// Run in the captured page after lazy loading and before measuring geometry.
// A paused or disabled entrance animation must not erase the finished page.
function stabilizeTildaEntrances() {
  const stats = { eligible: 0, revealed: 0, skipped: 0 };
  if (!document.querySelector('.t-records')) return stats;
  const entrance = /^(?:fadein|fadeinup|fadeindown|fadeinleft|fadeinright)$/i;
  const inactive = '[data-html2figma-hide="1"],.t-popup,[role="dialog"],dialog,[hidden],.swiper-slide:not(.swiper-slide-active),.slick-slide:not(.slick-active),.t-slds__item:not(.t-slds__item_active)';

  for (const el of document.querySelectorAll('.t-records .t-animate_wait[data-animate-style]')) {
    if (!entrance.test(String(el.getAttribute('data-animate-style') || '').trim())) continue;
    stats.eligible++;
    if (el.closest(inactive)) { stats.skipped++; continue; }
    let blocked = false;
    for (let node = el.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') {
        blocked = true;
        break;
      }
    }
    if (blocked) { stats.skipped++; continue; }
    // The author-positioned transform is intentional; a fade's final opacity
    // is the only property to force. This preserves Zero Block coordinates.
    el.classList.remove('t-animate_wait');
    el.style.setProperty('opacity', '1', 'important');
    el.setAttribute('data-html2figma-entrance-finished', '1');
    stats.revealed++;
  }
  return stats;
}

module.exports = { stabilizeTildaEntrances };
