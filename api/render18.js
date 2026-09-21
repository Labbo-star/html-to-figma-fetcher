const dns = require('node:dns').promises;
const net = require('node:net');
const render16 = require('./render16');

const MAX_HEIGHT = 60000;
const VIEWPORT_HEIGHT = 1100;
const NAV_TIMEOUT = 18000;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}
function isPrivateV4(ip) {
  const p = String(ip || '').split('.').map(Number);
  if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function isPrivateV6(ip) {
  const s = String(ip || '').toLowerCase().split('%')[0];
  if (s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || /^fe[89ab]/.test(s)) return true;
  if (s.startsWith('::ffff:')) { const v4 = s.slice(7); return net.isIP(v4) === 4 ? isPrivateV4(v4) : true; }
  return false;
}
function isPrivateIp(ip) { const t = net.isIP(ip); return t === 4 ? isPrivateV4(ip) : t === 6 ? isPrivateV6(ip) : true; }
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Некорректный URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Разрешены только http/https ссылки');
  if (u.username || u.password) throw new Error('URL с логином/паролем не поддерживаются');
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Адрес сайта не является публичным');
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new Error('Адрес сайта не является публичным'); return u; }
  const all = await Promise.race([
    Promise.all([dns.resolve4(host).catch(() => []), dns.resolve6(host).catch(() => [])]).then(([a, b]) => [...a, ...b]),
    new Promise(resolve => setTimeout(() => resolve([]), 2200)),
  ]);
  if (!all.length || all.some(isPrivateIp)) throw new Error('Адрес сайта не является публичным');
  return u;
}
async function modules() {
  const [p, c] = await Promise.all([import('puppeteer-core'), import('@sparticuz/chromium')]);
  return { puppeteer: p.default || p, chromium: c.default || c };
}
async function safeContinue(req) { try { if (!req.isInterceptResolutionHandled()) await req.continue(); } catch {} }
async function safeAbort(req) { try { if (!req.isInterceptResolutionHandled()) await req.abort('blockedbyclient'); } catch {} }

function mockRun(handler, req) {
  return new Promise((resolve, reject) => {
    let statusCode = 200, finished = false;
    const headers = {};
    const done = (body, kind) => { if (finished) return; finished = true; resolve({ statusCode, headers, body, kind }); };
    const res = {
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
      status(code) { statusCode = Number(code) || 200; return this; },
      json(body) { done(body, 'json'); return this; },
      send(body) { done(body, 'send'); return this; },
      end(body) { done(body, 'end'); return this; },
    };
    Promise.resolve(handler(req, res)).then(() => { if (!finished) done(undefined, 'end'); }).catch(reject);
  });
}
function forwardCaptured(c, res) {
  for (const [k, v] of Object.entries(c.headers || {})) try { res.setHeader(k, v); } catch {}
  const out = res.status(c.statusCode || 200);
  if (c.kind === 'json') return out.json(c.body);
  if (c.kind === 'send') return out.send(c.body);
  return out.end(c.body);
}

async function openBrowserPage(rawUrl, width) {
  const safe = await assertPublicUrl(rawUrl);
  const { puppeteer, chromium } = await modules();
  chromium.setGraphicsMode = false;
  const browser = await puppeteer.launch({
    args: [...chromium.args, '--disable-dev-shm-usage', '--disable-background-timer-throttling'],
    executablePath: await chromium.executablePath(), headless: 'shell',
    defaultViewport: { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7' });
  await page.setRequestInterception(true);
  page.on('request', async req => {
    try {
      const url = req.url(), type = req.resourceType();
      if (/^(data:|blob:|about:)/i.test(url)) return await safeContinue(req);
      if (!/^https?:/i.test(url) || ['media', 'websocket', 'eventsource'].includes(type)) return await safeAbort(req);
      const u = new URL(url);
      if ((net.isIP(u.hostname) && isPrivateIp(u.hostname)) || u.hostname === 'localhost' || u.hostname.endsWith('.local')) return await safeAbort(req);
      return await safeContinue(req);
    } catch { return await safeAbort(req); }
  });
  await page.goto(safe.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await Promise.race([page.waitForNetworkIdle({ idleTime: 300, timeout: 2500 }).catch(() => {}), new Promise(r => setTimeout(r, 2500))]);
  return { browser, page };
}

async function prepareAccurate(page) {
  await page.evaluate(() => {
    const vis = el => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return r.width > .5 && r.height > .5 && s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > .01; };
    const freeze = (root, itemSel, activeClass) => {
      let items = Array.from(root.querySelectorAll(':scope > ' + itemSel));
      if (!items.length) items = Array.from(root.querySelectorAll(itemSel));
      items = items.filter(el => !el.classList.contains('slick-cloned') && !el.classList.contains('swiper-slide-duplicate') && el.getAttribute('data-clone') !== 'true');
      if (items.length < 2) return;
      let keep = items.filter(el => el.classList.contains(activeClass) || el.classList.contains('slick-active') || el.classList.contains('swiper-slide-visible') || (el.classList.contains('owl-item') && el.classList.contains('active')) || el.getAttribute('aria-hidden') === 'false').filter(vis);
      if (!keep.length) keep = items.filter(vis).slice(0, 4);
      if (!keep.length) keep = [items[0]];
      const set = new Set(keep.slice(0, 6));
      items.forEach(el => el.setAttribute(set.has(el) ? 'data-h2f-keep' : 'data-h2f-hide', '1'));
    };
    const defs = [['.t-slds__items-wrapper','.t-slds__item','t-slds__item_active'],['.t-carousel__inner','.t-carousel__item','t-carousel__item_active'],['.swiper-wrapper','.swiper-slide','swiper-slide-active'],['.slick-track','.slick-slide','slick-active'],['.owl-stage','.owl-item','active']];
    for (const [rs,is,ac] of defs) for (const root of document.querySelectorAll(rs)) freeze(root,is,ac);
  }).catch(() => {});

  await page.evaluate(async maxHeight => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const root = document.scrollingElement || document.documentElement;
    const total = Math.min(maxHeight, Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0, 1));
    for (let y = 0; y < total; y += 850) { scrollTo(0, y); await sleep(65); }
    scrollTo(0, 0); await sleep(250);
    const pending = Array.from(document.images || []).filter(i => !i.complete);
    await Promise.race([Promise.all(pending.slice(0, 700).map(i => new Promise(done => { i.addEventListener('load', done, { once:true }); i.addEventListener('error', done, { once:true }); }))), sleep(4500)]);
    try { if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, sleep(1800)]); } catch {}
  }, MAX_HEIGHT);

  await page.evaluate(() => {
    document.querySelectorAll('.elementor-invisible').forEach(el => {
      el.classList.remove('elementor-invisible');
      if (el.style) { el.style.setProperty('visibility','visible','important'); el.style.setProperty('opacity','1','important'); }
    });
    document.querySelectorAll('[data-h2f-hide="1"]').forEach(el => { if (el.style) { el.style.setProperty('visibility','hidden','important'); el.style.setProperty('opacity','0','important'); } el.setAttribute('aria-hidden','true'); });
    document.querySelectorAll('[data-h2f-keep="1"]').forEach(el => { if (el.style) { el.style.setProperty('visibility','visible','important'); el.style.setProperty('opacity','1','important'); } el.setAttribute('aria-hidden','false'); });
    try { for (const a of document.getAnimations ? document.getAnimations() : []) { try { a.finish(); } catch { try { a.pause(); } catch {} } } } catch {}
  }).catch(() => {});
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}[data-h2f-hide="1"]{visibility:hidden!important;opacity:0!important}' }).catch(() => {});
  await new Promise(r => setTimeout(r, 120));
}

async function capturePaintMap(page) {
  await page.evaluate(() => { let i = 1; for (const el of document.querySelectorAll('body *')) el.setAttribute('data-h2f-node', String(i++)); });
  const map = {};
  try {
    const session = await page.createCDPSession();
    const snap = await session.send('DOMSnapshot.captureSnapshot', { computedStyles: [], includePaintOrder: true, includeDOMRects: false, includeBlendedBackgroundColors: false, includeTextColorOpacities: false });
    const strings = snap.strings || [];
    for (const doc of snap.documents || []) {
      const attrs = doc.nodes && doc.nodes.attributes || [], nodeIndex = doc.layout && doc.layout.nodeIndex || [], paintOrders = doc.layout && doc.layout.paintOrders || [];
      for (let i = 0; i < nodeIndex.length; i++) {
        const ni = nodeIndex[i], a = attrs[ni] || [];
        for (let j = 0; j + 1 < a.length; j += 2) {
          if (strings[a[j]] === 'data-h2f-node') { const id = strings[a[j + 1]]; if (id) map[id] = Number(paintOrders[i] || 0); break; }
        }
      }
    }
    await session.detach().catch(() => {});
  } catch {}
  return map;
}

async function collectEnrichment(page, width, paintMap) {
  return await page.evaluate(({ viewportWidth, paintMap }) => {
    const doc = document, win = window;
    const n = (v,f=0) => { const x=parseFloat(v); return Number.isFinite(x)?x:f; }, rnd = v => Math.round(v*100)/100;
    const rgba = v => { const m=String(v||'').match(/rgba?\(([^)]+)\)/i); if(!m)return {r:0,g:0,b:0,a:0}; const p=m[1].split(',').map(x=>parseFloat(x)); return {r:Math.max(0,Math.min(1,(p[0]||0)/255)),g:Math.max(0,Math.min(1,(p[1]||0)/255)),b:Math.max(0,Math.min(1,(p[2]||0)/255)),a:p.length>3&&Number.isFinite(p[3])?Math.max(0,Math.min(1,p[3])):1}; };
    const box = r => ({ x:rnd(r.left+scrollX), y:rnd(r.top+scrollY), width:rnd(r.width), height:rnd(r.height) });
    const visible = el => {
      const r=el.getBoundingClientRect(), s=getComputedStyle(el); if(r.width<=.5||r.height<=.5||s.display==='none'||s.visibility==='hidden'||n(s.opacity,1)<=.01)return false;
      if(r.right<=0||r.left>=innerWidth)return false;
      for(let p=el,i=0;p&&p!==doc.documentElement&&i<30;i++,p=p.parentElement){ const cs=getComputedStyle(p); if(p.hidden||p.getAttribute('aria-hidden')==='true'||cs.display==='none'||cs.visibility==='hidden'||n(cs.opacity,1)<=.01)return false; }
      return true;
    };
    const pname = el => ((el.tagName||'node').toLowerCase()+(el.id?'#'+el.id:'')+(el.classList&&el.classList.length?'.'+Array.from(el.classList).slice(0,2).join('.'):'')).slice(0,100);
    const po = el => Number(paintMap[el.getAttribute('data-h2f-node')||''] || 0);
    const urlList = v => Array.from(new Set(Array.from(String(v||'').matchAll(/url\((?:"|')?([^"')]+)(?:"|')?\)/gi)).map(m=>{try{return new URL(m[1],location.href).href}catch{return m[1]}})));
    const logical = el => {
      if (!el.querySelector('br')) return String(el.innerText||el.textContent||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
      let out=''; const walk=node=>{ if(node.nodeType===3){out+=String(node.nodeValue||'').replace(/\s+/g,' ')} else if(node.nodeType===1){ if(node.tagName==='BR'){out+='\n';return} for(const ch of node.childNodes)walk(ch) } }; walk(el);
      return out.replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
    };
    const std = Array.from(doc.querySelectorAll('#allrecords > .t-rec,.t-rec[id],header,main > section,footer'));
    const elem = Array.from(doc.querySelectorAll('body > .elementor > .e-con.e-parent,body > .elementor > .elementor-element.elementor-top-section,main .elementor > .e-con.e-parent,main .elementor > .elementor-element.elementor-top-section,.elementor > .e-con.e-parent'));
    let sectionEls = [...std, ...elem].filter((e,i,a)=>a.indexOf(e)===i&&visible(e));
    sectionEls = sectionEls.filter(e => !sectionEls.some(p => p!==e && p.contains(e) && (p.matches('.e-con.e-parent,.elementor-top-section'))));
    if(!sectionEls.length) sectionEls=Array.from(doc.body?doc.body.children:[]).filter(visible);
    sectionEls.sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);
    const sections=[]; for(let i=0;i<sectionEls.length;i++){const e=sectionEls[i],r=e.getBoundingClientRect(),s=getComputedStyle(e); sections.push({id:'section-'+i,name:(e.id||e.getAttribute('data-id')||Array.from(e.classList||[]).find(x=>x!=='elementor-element'&&x!=='e-con')||e.tagName.toLowerCase()).slice(0,90),y:rnd(r.top+scrollY),height:rnd(r.height),clipsContent:['hidden','clip'].includes(String(s.overflowY||s.overflow).toLowerCase())||['hidden','clip'].includes(String(s.overflowX||s.overflow).toLowerCase())});}
    const sectionForY=y=>{let hit=null;for(const s of sections)if(y>=s.y-2&&y<=s.y+s.height+2){if(!hit||s.height<hit.height)hit=s}return hit?hit.id:(sections[0]&&sections[0].id)};
    const elements=[]; for(const e of doc.querySelectorAll('body *')){ if(!(e instanceof HTMLElement||e instanceof SVGElement)||!visible(e))continue; const r=e.getBoundingClientRect(); if(r.width>viewportWidth*2.5||r.height>12000)continue; elements.push({id:e.getAttribute('data-h2f-node')||'',tag:(e.tagName||'').toLowerCase(),name:pname(e),...box(r),paintOrder:po(e)}); }
    const textSel='h1,h2,h3,h4,h5,h6,p,li,label,button,a,.tn-atom,.t-title,.t-name,.t-descr,.t-text,.elementor-heading-title,.elementor-button-text,.elementor-widget-text-editor';
    const textCandidates=[]; for(const e of doc.querySelectorAll(textSel)){ if(!visible(e))continue; const t=logical(e); if(!t||t.length>12000)continue; if(e.matches('.elementor-widget-text-editor')&&e.querySelector('p,li,h1,h2,h3,h4,h5,h6'))continue; const r=e.getBoundingClientRect(),s=getComputedStyle(e),fs=n(s.fontSize,16),lh=s.lineHeight==='normal'?fs*1.2:n(s.lineHeight,fs*1.2),pl=n(s.paddingLeft)+n(s.borderLeftWidth),pr=n(s.paddingRight)+n(s.borderRightWidth),pt=n(s.paddingTop)+n(s.borderTopWidth),pb=n(s.paddingBottom)+n(s.borderBottomWidth),x=r.left+scrollX+pl,y=r.top+scrollY+pt,w=Math.max(1,r.width-pl-pr),h=Math.max(1,r.height-pt-pb); const ta=String(s.textAlign||'left').toUpperCase(); textCandidates.push({kind:'text',name:pname(e)+' — текст',x:rnd(x),y:rnd(y),absX:rnd(x),absY:rnd(y),width:rnd(w),height:rnd(h),opacity:n(s.opacity,1),text:t,textRole:/^H[1-6]$/.test(e.tagName)?e.tagName:(e.matches('button,.elementor-button-text')?'Button':'Body'),fontSize:fs,fontWeight:n(s.fontWeight,400),fontFamily:String(s.fontFamily||'Inter').split(',')[0].trim().replace(/^['"]|['"]$/g,''),fontStyle:String(s.fontStyle||'normal'),lineHeight:lh,letterSpacing:s.letterSpacing==='normal'?0:n(s.letterSpacing),textAlign:ta==='CENTER'?'CENTER':(ta==='RIGHT'||ta==='END'?'RIGHT':(ta==='JUSTIFY'?'JUSTIFIED':'LEFT')),textDecoration:String(s.textDecorationLine||'none'),textSizing:'FIXED',fill:{kind:'solid',color:rgba(s.color)},sectionId:sectionForY(y+Math.min(4,h/2)),paintOrder:po(e),paintPhase:2}); }
    const images=[]; for(const e of doc.querySelectorAll('img')){ if(!visible(e))continue; const r=e.getBoundingClientRect(),s=getComputedStyle(e),u=e.getAttribute('data-original')||e.getAttribute('data-src')||e.currentSrc||e.src||''; if(!u)continue; let url=u;try{url=new URL(u,location.href).href}catch{} images.push({kind:'image',name:pname(e),...box(r),absX:rnd(r.left+scrollX),absY:rnd(r.top+scrollY),opacity:n(s.opacity,1),url,sourceUrl:url,imageScaleMode:String(s.objectFit||'').toLowerCase()==='contain'?'FIT':'FILL',objectPosition:String(s.objectPosition||'50% 50%'),sectionId:sectionForY(r.top+scrollY+r.height/2),paintOrder:po(e),paintPhase:2}); }
    const backgrounds=[]; for(const e of doc.querySelectorAll('body *')){ if(!(e instanceof HTMLElement)||!visible(e))continue; const r=e.getBoundingClientRect(),s=getComputedStyle(e),urls=urlList(s.backgroundImage); if(!urls.length||r.width<4||r.height<4||r.width>viewportWidth*1.8||r.height>5000)continue; backgrounds.push({kind:'image',name:pname(e)+' — фон',...box(r),absX:rnd(r.left+scrollX),absY:rnd(r.top+scrollY),opacity:n(s.opacity,1),url:urls[0],sourceUrl:urls[0],imageScaleMode:String(s.backgroundSize||'').includes('contain')?'FIT':'FILL',backgroundPosition:String(s.backgroundPosition||'50% 50%'),backgroundSize:String(s.backgroundSize||'cover'),sectionId:sectionForY(r.top+scrollY+r.height/2),paintOrder:po(e),paintPhase:0}); }
    let visualBottom=0; for(const s of sections)visualBottom=Math.max(visualBottom,s.y+s.height); for(const e of elements)visualBottom=Math.max(visualBottom,e.y+e.height); const scrollH=Math.max(doc.documentElement.scrollHeight,doc.body?doc.body.scrollHeight:0,1); let height=visualBottom>0?visualBottom:scrollH; if(scrollH<=height*1.25)height=Math.max(height,scrollH); height=Math.max(1,Math.min(60000,Math.ceil(height)));
    return {sections,elements,textCandidates,images,backgrounds,height,scrollHeight:scrollH};
  }, { viewportWidth: width, paintMap });
}

function normText(v) { return String(v || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function tagFromName(v) { const m = String(v || '').match(/^([a-z0-9-]+)/i); return m ? m[1].toLowerCase() : ''; }
function rectScore(a,b) { const acx=(Number(a.absX ?? a.x)||0)+(Number(a.width)||0)/2, acy=(Number(a.absY ?? a.y)||0)+(Number(a.height)||0)/2, bcx=(Number(b.x)||0)+(Number(b.width)||0)/2, bcy=(Number(b.y)||0)+(Number(b.height)||0)/2; return Math.abs(acx-bcx)+Math.abs(acy-bcy)+.35*Math.abs((Number(a.width)||0)-(Number(b.width)||0))+.35*Math.abs((Number(a.height)||0)-(Number(b.height)||0)); }
function bestElement(layer, elements) { const tag=tagFromName(layer.name), pool=elements.filter(e=>!tag||e.tag===tag); let best=null,score=Infinity; for(const e of pool){const s=rectScore(layer,e);if(s<score){score=s;best=e}} return score<=Math.max(28,(Number(layer.width)||0)*.08+(Number(layer.height)||0)*.08)?best:null; }
function nearestSectionId(sections,y){let best=null;for(const s of sections||[]){if(y>=s.y-2&&y<=s.y+s.height+2){if(!best||s.height<best.height)best=s}}return best&&best.id;}
function enrich(base, extra) {
  const layers = Array.isArray(base.layers) ? base.layers.map(x=>({...x})) : [];
  const texts = extra.textCandidates || [], elements = extra.elements || [];
  for (const l of layers) {
    let matched = null;
    if (l.kind === 'text') {
      const nt=normText(l.text), candidates=texts.filter(t=>normText(t.text)===nt);
      let score=Infinity; for(const t of candidates){const s=rectScore(l,t);if(s<score){score=s;matched=t}}
      if (matched && score < Math.max(90,(Number(l.width)||0)*.35)) { l.text = matched.text; l.paintOrder = matched.paintOrder; }
    }
    if (!matched) { const e=bestElement(l,elements); if(e) l.paintOrder=e.paintOrder; }
  }
  const near = (a,b,tol=8) => Math.abs((Number(a.absX??a.x)||0)-(Number(b.absX??b.x)||0))<=tol && Math.abs((Number(a.absY??a.y)||0)-(Number(b.absY??b.y)||0))<=tol && Math.abs((Number(a.width)||0)-(Number(b.width)||0))<=tol*2 && Math.abs((Number(a.height)||0)-(Number(b.height)||0))<=tol*2;
  for(const t of texts){const nt=normText(t.text);if(!nt)continue;const exists=layers.some(l=>l.kind==='text'&&normText(l.text)===nt&&near(l,t,14));if(!exists)layers.push({...t,z:layers.length});}
  for(const im of [...(extra.images||[]),...(extra.backgrounds||[])]){const u=String(im.sourceUrl||im.url||'');const exists=layers.some(l=>l.kind==='image'&&(near(l,im,12)||(u&&String(l.sourceUrl||l.url||'')===u&&rectScore(l,im)<80)));if(!exists)layers.push({...im,z:layers.length,captureSafe:false});}
  const sections=(extra.sections&&extra.sections.length)?extra.sections:base.sections||[];
  for(const l of layers){const y=(Number(l.absY??l.y)||0)+(Number(l.height)||0)/2;const sid=nearestSectionId(sections,y);if(sid)l.sectionId=sid;}
  layers.sort((a,b)=>(Number(a.paintOrder)||Number(a.z)||0)-(Number(b.paintOrder)||Number(b.z)||0)||(Number(a.paintPhase)||1)-(Number(b.paintPhase)||1)||(Number(a.z)||0)-(Number(b.z)||0));
  layers.forEach((l,i)=>{l.z=i});
  return {...base,layers,sections,height:extra.height||base.height,rendererVersion:18,enrichment:{paintOrder:true,logicalText:true,elementorReveal:true,addedLayers:Math.max(0,layers.length-(base.layers||[]).length),documentScrollHeight:extra.scrollHeight}};
}

async function accurateReference(raw,width,res){
  let browser;
  try{const o=await openBrowserPage(raw,width);browser=o.browser;await prepareAccurate(o.page);const h=await o.page.evaluate(()=>Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0,1));const height=Math.min(30000,Math.max(1,Number(h)||1));const buf=await o.page.screenshot({type:'webp',quality:84,clip:{x:0,y:0,width,height},captureBeyondViewport:true});res.setHeader('Content-Type','image/webp');return res.status(200).send(buf)}catch(e){return res.status(500).json({ok:false,error:e&&e.message?e.message:String(e)})}finally{if(browser)await browser.close().catch(()=>{})}
}

module.exports = async function handler(req,res){
  cors(res);
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method==='GET'&&String(req.query&&req.query.ping||'')==='1')return res.status(200).json({ok:true,service:'browser-renderer',version:18,paintOrder:'cdp',logicalText:true,elementorReveal:true,visualQa:true});
  const raw=req.method==='POST'?(req.body&&req.body.url):(req.query&&req.query.url), rawUrl=Array.isArray(raw)?raw[0]:raw;
  const rw=req.method==='POST'?(req.body&&req.body.width):(req.query&&req.query.width), width=Math.max(320,Math.min(1920,Number(Array.isArray(rw)?rw[0]:rw)||1440));
  if(req.method==='GET'&&String(req.query&&req.query.reference||'')==='1'){if(!rawUrl)return res.status(400).json({ok:false,error:'Не передан параметр url'});return accurateReference(String(rawUrl),width,res);}
  if(req.method==='POST'&&String(req.body&&req.body.mode||'')==='capture-clips')return render16(req,res);
  if(req.method!=='GET')return render16(req,res);
  const captured=await mockRun(render16,req);
  if(captured.statusCode!==200||!captured.body||!captured.body.snapshot||!rawUrl)return forwardCaptured(captured,res);
  let browser;
  try{
    const opened=await openBrowserPage(String(rawUrl),width);browser=opened.browser;await prepareAccurate(opened.page);const paintMap=await capturePaintMap(opened.page);const extra=await collectEnrichment(opened.page,width,paintMap);const snapshot=enrich(captured.body.snapshot,extra);return res.status(200).json({ok:true,mode:'browser-snapshot-v18',finalUrl:captured.body.finalUrl||String(rawUrl),snapshot,stats:{layers:snapshot.layers.length,sections:snapshot.sections.length,truncated:!!snapshot.truncated,imageLayers:snapshot.layers.filter(x=>x.kind==='image').length,addedLayers:snapshot.enrichment&&snapshot.enrichment.addedLayers,scrollHeight:snapshot.enrichment&&snapshot.enrichment.documentScrollHeight}});
  }catch(e){
    return forwardCaptured(captured,res);
  }finally{if(browser)await browser.close().catch(()=>{})}
};
