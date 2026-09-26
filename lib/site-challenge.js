// Runs inside the page. Reject an access challenge before it becomes a design.
function detectSiteChallenge() {
  const title = String(document.title || '').toLowerCase();
  const text = String(document.body?.innerText || '').slice(0, 2600).toLowerCase();
  const challengeNode = document.querySelector('#challenge-form,#challenge-stage,#cf-challenge-running,.cf-browser-verification');
  const cloudflare = /cloudflare|ray id\s*:/i.test(title + ' ' + text);
  const rayId = /ray id\s*:/i.test(text);
  const verification = /verify you are human|checking (?:your browser|if (?:you|the site visitor) (?:are|is) human)|security check|just a moment|провер(?:ка|ку) безопасности|проверьте, что вы (?:человек|не бот)|что вы не бот|выполнение проверки безопасности/i.test(title + ' ' + text);
  if ((challengeNode && (cloudflare || verification)) || (cloudflare && verification && rayId && text.length < 1800)) {
    return { blocked: true, provider: cloudflare ? 'Cloudflare' : 'site-challenge' };
  }
  return { blocked: false };
}

module.exports = { detectSiteChallenge };
