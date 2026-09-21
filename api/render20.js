const dns = require('node:dns').promises;
const net = require('node:net');
const render17 = require('./render17');

const MAX_LAYERS = 3600;
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
    Promise.all([dns.resolve4(host).catch(() => []), dns.resolve6(host).catch(() => [])]).then(([a,b]) => [...a,...b]),
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
    let statusCode = 200, finished = false; const headers = {};
    const done = (kind, body) => { if (finished) return; finished = true; resolve({ statusCode, headers, kind, body }); };
    const res = {
      setHeader(k,v){ headers[String(k).toLowerCase()] = v; return this; },
      status(c){ statusCode = Number(c) || 200; return this; },
      json(b){ done('json', b); return this; }, send(b){ done('send', b); return this; }, end(b){ done('end', b); return this; },
    };
    Promise.resolve(handler(req,res)).then(() => { if (!finished) done('end', undefined); }).catch(reject);
  });
}
function forward(result, res) {
  for (const [k,v] of Object.entries(result.headers || {})) try { res.setHeader(k,v); } catch {}
  const out = res.status(result.statusCode || 200);
  if (result.kind === 'json') return out.json(result.body);
  if (result.kind === 'send') return out.send(result.body);
  return out.end(result.body);
}

const POPUP_RE = /(cookie|cookies|consent|gdpr|cookieyes|cky[-_]|cmplz|t-cookie|tildacookie|popup|pop-up|modal|dialog|pum-|popmake|jet-popup|elementor-popup|complianz|onetrust|cookiebot)/i;
function postprocessStable(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.layers)) return snapshot;
  const blockedContainers = new Set();
  for (const l of snapshot.layers) if (l && l.kind === 'container' && l.containerKey && POPUP_RE.test(String(l.name || ''))) blockedContainers.add(l.containerKey);
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of snapshot.layers) if (l && l.kind === 'container' && l.containerKey && l.parentContainerKey && blockedContainers.has(l.parentContainerKey) && !blockedContainers.has(l.containerKey)) { blockedContainers.add(l.containerKey); changed = true; }
  }
  const filtered = [];
  const seen = new Set();
  for (const raw of snapshot.layers) {
    if (!raw) continue;
    const l = { ...raw };
    const text = String(l.text || '');
    if (POPUP_RE.test(String(l.name || '')) || /(?:файл(?:ы|ов)?\s+cookie|используем\s+cookie|настройк[аи]\s+cookie|политик[аи]\s+cookie)/i.test(text) || (l.parentContainerKey && blockedContainers.has(l.parentContainerKey))) continue;
    if (l.kind === 'text' && text.includes('\n')) l.text = text.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const k = [l.kind, Math.round(Number(l.absX ?? l.x) * 2) / 2, Math.round(Number(l.absY ?? l.y) * 2) / 2, Math.round(Number(l.width) * 2) / 2, Math.round(Number(l.height) * 2) / 2, String(l.text || '').replace(/\s+/g,' ').trim(), String(l.url || '')].join('|');
    if (seen.has(k)) continue; seen.add(k); filtered.push(l);
  }
  const bySection = new Map();
  for (const l of filtered) { const id = l.sectionId || ''; if (!bySection.has(id)) bySection.set(id, []); bySection.get(id).push(l); }
  for (const group of bySection.values()) {
    const cards = group.filter(l => (l.kind === 'container' || l.kind === 'shape') && l.fill && l.width > 70 && l.height > 50 && l.width < 700 && l.height < 500);
    for (const img of group.filter(l => l.kind === 'image' && l.width > 180 && l.height > 180 && l.captureMode !== 'background')) {
      let hits = 0, minStack = Infinity;
      for (const c of cards) {
        if (img.width < c.width * 1.15 || img.height < c.height * 1.15) continue;
        const ax = Number(img.absX ?? img.x), ay = Number(img.absY ?? img.y), bx = Number(c.absX ?? c.x), by = Number(c.absY ?? c.y);
        const iw = Math.max(0, Math.min(ax + img.width, bx + c.width) - Math.max(ax, bx));
        const ih = Math.max(0, Math.min(ay + img.height, by + c.height) - Math.max(ay, by));
        if (iw * ih > c.width * c.height * .18) { hits++; const p = Array.isArray(c.stackPath) && c.stackPath.length ? Number(c.stackPath[c.stackPath.length - 1]) : Number(c.zIndex || 0); minStack = Math.min(minStack, p); }
      }
      if (hits >= 2 && Number.isFinite(minStack)) { img.stackPath = [minStack - 1]; img.zIndex = minStack - 1; img.paintPhase = -1; }
    }
  }
  snapshot.layers = filtered;
  snapshot.rendererVersion = 20;
  snapshot.popupSuppression = true;
  snapshot.logicalText = true;
  return snapshot;
}

async function detectElementor(raw) {
  const safe = await assertPublicUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const r = await fetch(safe.href, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/149 Safari/537.36', 'Accept': 'text/html,*/*' }, redirect: 'follow', signal: controller.signal });
    if (!r.ok) return false;
    const t = (await r.text()).slice(0, 2500000);
    return /(?:elementor-page|elementor-element|name=["']generator["'][^>]*elementor|\/wp-content\/plugins\/elementor)/i.test(t);
  } catch { return false; } finally { clearTimeout(timer); }
}

async function openElementorPage(rawUrl, width) {
  const safe = await assertPublicUrl(rawUrl), { puppeteer, chromium } = await modules();
  chromium.setGraphicsMode = false;
  const browser = await puppeteer.launch({ args:[...chromium.args,'--disable-dev-shm-usage','--disable-background-timer-throttling'], executablePath: await chromium.executablePath(), headless:'shell', defaultViewport:{ width, height:VIEWPORT_HEIGHT, deviceScaleFactor:1 } });
  const page = await browser.newPage();
  await page.setViewport({ width, height:VIEWPORT_HEIGHT, deviceScaleFactor:1 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language':'ru-RU,ru;q=0.9,en;q=0.7' });
  await page.setRequestInterception(true);
  page.on('request', async req => { try { const u=req.url(), type=req.resourceType(); if (/^(data:|blob:|about:)/i.test(u)) return safeContinue(req); if (!/^https?:/i.test(u) || ['media','websocket','eventsource'].includes(type)) return safeAbort(req); const x=new URL(u); if ((net.isIP(x.hostname)&&isPrivateIp(x.hostname)) || x.hostname==='localhost' || x.hostname.endsWith('.local')) return safeAbort(req); return safeContinue(req); } catch { return safeAbort(req); } });
  await page.goto(safe.href, { waitUntil:'domcontentloaded', timeout:NAV_TIMEOUT });
  await Promise.race([page.waitForNetworkIdle({ idleTime:350, timeout:3500 }).catch(()=>{}), new Promise(r=>setTimeout(r,3500))]);
  return { browser, page };
}

async function prepareElementor(page) {
  await page.evaluate(() => {
    const selectors = [
      '.elementor-popup-modal','.dialog-widget','.dialog-lightbox-widget','[role="dialog"][aria-modal="true"]',
      '.cky-consent-container','.cky-modal','.cmplz-cookiebanner','.cmplz-cookiebanner-container','#onetrust-banner-sdk',
      '.cookie-notice-container','#cookie-notice','.cookie-banner','.cookies-banner','.cookie-popup','.gdpr-cookie-notice',
      '.t-cookie','.t-cookie__container','#tildacookie','.pum-overlay','.popmake','.jet-popup'
    ];
    document.querySelectorAll(selectors.join(',')).forEach(el => { try { el.remove(); } catch { if (el.style) el.style.display='none'; } });
    document.querySelectorAll('.elementor-invisible').forEach(el => { el.classList.remove('elementor-invisible'); if (el.style) { el.style.setProperty('visibility','visible','important'); el.style.setProperty('opacity','1','important'); el.style.setProperty('transform','none','important'); } });
  }).catch(()=>{});
  await page.evaluate(async max => { const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const root=document.scrollingElement||document.documentElement; const total=Math.min(max,Math.max(root.scrollHeight,document.body?document.body.scrollHeight:0,1)); for(let y=0;y<total;y+=850){scrollTo(0,y);await sleep(80)} scrollTo(0,0); await sleep(250); const pending=Array.from(document.images||[]).filter(i=>!i.complete); await Promise.race([Promise.all(pending.slice(0,700).map(i=>new Promise(done=>{i.addEventListener('load',done,{once:true});i.addEventListener('error',done,{once:true})}))),sleep(5500)]); try{if(document.fonts&&document.fonts.ready)await Promise.race([document.fonts.ready,sleep(2200)])}catch{} }, MAX_HEIGHT);
  await page.evaluate(() => {
    document.querySelectorAll('.elementor-invisible').forEach(el => { el.classList.remove('elementor-invisible'); if (el.style) { el.style.setProperty('visibility','visible','important'); el.style.setProperty('opacity','1','important'); el.style.setProperty('transform','none','important'); } });
    try { for (const a of document.getAnimations ? document.getAnimations() : []) { try { a.finish(); } catch { try { a.pause(); } catch {} } } } catch {}
  }).catch(()=>{});
  await page.addStyleTag({ content:'*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}' }).catch(()=>{});
  await new Promise(r=>setTimeout(r,180));
}

async function collectElementor(page, width) {
  return await page.evaluate(({ maxLayers, maxHeight, viewportWidth }) => {
    const win=window, doc=document, layers=[], sections=[], seen=new Set(); let seq=0, imgSeq=0, bgSeq=0, truncated=false;
    const num=(v,f=0)=>{const n=parseFloat(v);return Number.isFinite(n)?n:f}, round=v=>Math.round(v*100)/100;
    const color=v=>{const m=String(v||'').match(/rgba?\(([^)]+)\)/i);if(!m)return{r:0,g:0,b:0,a:0};const p=m[1].split(',').map(x=>parseFloat(x));return{r:Math.max(0,Math.min(1,(p[0]||0)/255)),g:Math.max(0,Math.min(1,(p[1]||0)/255)),b:Math.max(0,Math.min(1,(p[2]||0)/255)),a:p.length>3&&Number.isFinite(p[3])?Math.max(0,Math.min(1,p[3])):1}};
    const rect=r=>({x:round(r.left+scrollX),y:round(r.top+scrollY),width:round(r.width),height:round(r.height)});
    const name=(e,s='')=>((e.tagName||'node').toLowerCase()+(e.id?'#'+e.id:'')+(e.classList&&e.classList.length?'.'+Array.from(e.classList).slice(0,2).join('.'):'')+s).slice(0,100);
    const urls=v=>Array.from(new Set(Array.from(String(v||'').matchAll(/url\((?:"|')?([^"')]+)(?:"|')?\)/gi)).map(m=>{try{return new URL(m[1],location.href).href}catch{return m[1]}})));
    const popup=e=>!!(e.closest&&e.closest('.elementor-popup-modal,.dialog-widget,.dialog-lightbox-widget,[role="dialog"][aria-modal="true"],.cky-consent-container,.cky-modal,.cmplz-cookiebanner,#onetrust-banner-sdk,.cookie-banner,.cookie-popup,.t-cookie,#tildacookie,.pum-overlay,.popmake,.jet-popup'));
    const visible=e=>{if(!e||popup(e))return false;const s=getComputedStyle(e),r=e.getBoundingClientRect();if(r.width<=.5||r.height<=.5||s.display==='none'||s.visibility==='hidden'||num(s.opacity,1)<=.01)return false;if(r.right<=0||r.left>=innerWidth)return false;for(let p=e,i=0;p&&p!==doc.documentElement&&i<35;i++,p=p.parentElement){const cs=getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||cs.display==='none'||cs.visibility==='hidden'||num(cs.opacity,1)<=.01)return false}return true};
    const z=e=>{const out=[];for(let n=e;n&&n!==doc.body;n=n.parentElement){const s=getComputedStyle(n),zi=parseInt(s.zIndex,10);if((s.position!=='static'&&s.zIndex!=='auto')||s.transform!=='none'||num(s.opacity,1)<.999)out.unshift(Number.isFinite(zi)?zi:0)}return out.slice(-10)};
    const add=l=>{if(layers.length>=maxLayers){truncated=true;return}if(!l||l.width<=.5||l.height<=.5)return;const k=[l.kind,round(l.absX??l.x),round(l.absY??l.y),round(l.width),round(l.height),String(l.text||'').replace(/\s+/g,' ').trim(),l.url||'',l.fill&&l.fill.kind==='solid'?JSON.stringify(l.fill.color):''].join('|');if(seen.has(k))return;seen.add(k);l.z=seq++;layers.push(l)};
    const radius=s=>Math.max(num(s.borderTopLeftRadius),num(s.borderTopRightRadius),num(s.borderBottomLeftRadius),num(s.borderBottomRightRadius));
    const borderWidth=s=>Math.max(num(s.borderTopWidth),num(s.borderRightWidth),num(s.borderBottomWidth),num(s.borderLeftWidth));
    const borderColor=s=>color(num(s.borderTopWidth)?s.borderTopColor:num(s.borderRightWidth)?s.borderRightColor:num(s.borderBottomWidth)?s.borderBottomColor:s.borderLeftColor);
    const shadow=v=>{const raw=String(v||'');if(!raw||raw==='none'||raw.includes('inset'))return null;const cm=raw.match(/rgba?\([^)]*\)/i),ns=raw.replace(cm?cm[0]:'','').match(/-?[\d.]+px/g)||[];if(ns.length<2)return null;return{color:color(cm?cm[0]:'rgba(0,0,0,.2)'),x:num(ns[0]),y:num(ns[1]),blur:num(ns[2]),spread:num(ns[3])}};
    const fill=s=>color(s.backgroundColor).a>.01?{kind:'solid',color:color(s.backgroundColor)}:undefined;
    let sectionEls=Array.from(doc.querySelectorAll('body > .elementor > .e-con.e-parent,body > .elementor > .elementor-top-section,main > .elementor > .e-con.e-parent,main > .elementor > .elementor-top-section,.elementor > .e-con.e-parent')).filter((e,i,a)=>a.indexOf(e)===i&&visible(e));
    sectionEls=sectionEls.filter(e=>!sectionEls.some(p=>p!==e&&p.contains(e)&&p.matches('.e-con.e-parent,.elementor-top-section')));
    if(!sectionEls.length){const root=doc.querySelector('.elementor');if(root)sectionEls=Array.from(root.children).filter(visible)}
    if(!sectionEls.length)sectionEls=Array.from(doc.body?doc.body.children:[]).filter(visible);
    sectionEls.sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);
    const sectionMap=new Map();
    sectionEls.forEach((e,i)=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e),id='section-'+i,b=rect(r);sectionMap.set(e,id);sections.push({id,name:(e.id||Array.from(e.classList||[]).find(x=>x!=='elementor-element')||'elementor').slice(0,90),y:b.y,height:b.height,clipsContent:['hidden','clip'].includes(String(s.overflowY||s.overflow).toLowerCase())||['hidden','clip'].includes(String(s.overflowX||s.overflow).toLowerCase())});const f=fill(s);if(f)add({kind:'shape',name:'section background',...b,absX:b.x,absY:b.y,opacity:num(s.opacity,1),fill:f,sectionId:id,stackPath:[-100000],zIndex:-100000,paintPhase:-100});for(const u of urls(s.backgroundImage).slice(0,1))add({kind:'image',name:'section background image',...b,absX:b.x,absY:b.y,opacity:num(s.opacity,1),url:u,sourceUrl:u,imageScaleMode:String(s.backgroundSize).includes('contain')?'FIT':'FILL',sectionId:id,stackPath:[-99999],zIndex:-99999,paintPhase:-99,captureSafe:true,captureId:'bg-'+(bgSeq++),captureMode:'background'})});
    const sectionFor=(e,r)=>{let n=e;while(n&&n!==doc.body){if(sectionMap.has(n))return sectionMap.get(n);n=n.parentElement}const y=r.top+scrollY+Math.min(4,r.height/2);const s=sections.find(x=>y>=x.y-2&&y<=x.y+x.height+2);return s?s.id:(sections[0]?sections[0].id:undefined)};
    const textSel='h1,h2,h3,h4,h5,h6,p,li,label,.elementor-heading-title,.elementor-button-text,.elementor-icon-list-text,.elementor-field-label,.elementor-widget-text-editor';
    const textOwners=Array.from(doc.querySelectorAll(textSel)).filter(visible);
    for(const e of textOwners){if(truncated)break;if(e.matches('.elementor-widget-text-editor')&&e.querySelector('p,h1,h2,h3,h4,h5,h6,li'))continue;const s=getComputedStyle(e),r=e.getBoundingClientRect(),text=String(e.innerText||e.textContent||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();if(!text||text.length>12000)continue;const b=rect(r),fs=num(s.fontSize,16),lh=s.lineHeight==='normal'?fs*1.2:num(s.lineHeight,fs*1.2),pl=num(s.paddingLeft)+num(s.borderLeftWidth),pr=num(s.paddingRight)+num(s.borderRightWidth),pt=num(s.paddingTop)+num(s.borderTopWidth),pb=num(s.paddingBottom)+num(s.borderBottomWidth),x=round(b.x+pl),y=round(b.y+pt),w=Math.max(1,round(b.width-pl-pr)),h=Math.max(lh,round(b.height-pt-pb)),lines=Math.max(1,Math.round(h/Math.max(1,lh)));add({kind:'text',name:name(e,' — текст'),x,y,absX:x,absY:y,width:w,height:h,opacity:num(s.opacity,1),fill:{kind:'solid',color:color(s.color)},text,expectedLineCount:lines,textRole:/^H[1-6]$/.test(e.tagName)?e.tagName:(e.closest('.elementor-button')?'Button':'Body'),fontSize:fs,fontWeight:num(s.fontWeight,400),fontFamily:String(s.fontFamily||'Inter').split(',')[0].trim().replace(/^['"]|['"]$/g,''),fontStyle:String(s.fontStyle||'normal'),lineHeight:lh,letterSpacing:s.letterSpacing==='normal'?0:num(s.letterSpacing),textAlign:['center','right','justify'].includes(String(s.textAlign))?String(s.textAlign).toUpperCase():'LEFT',textSizing:'FIXED',sectionId:sectionFor(e,r),stackPath:z(e),zIndex:0,paintPhase:3})}
    const all=Array.from(doc.querySelectorAll('body *'));
    for(const e of all){if(truncated)break;if(!(e instanceof HTMLElement)||!visible(e))continue;const s=getComputedStyle(e),r=e.getBoundingClientRect(),b=rect(r),sectionId=sectionFor(e,r),sp=z(e),rad=radius(s),bw=borderWidth(s),sh=shadow(s.boxShadow),bg=fill(s);if(e.tagName==='IMG'){const raw=e.getAttribute('data-original')||e.getAttribute('data-src')||e.currentSrc||e.getAttribute('src')||'';if(raw){let u=raw;try{u=new URL(raw,location.href).href}catch{}const cap='img-'+(imgSeq++);try{e.setAttribute('data-h2f-capture',cap)}catch{}add({kind:'image',name:name(e),...b,absX:b.x,absY:b.y,opacity:num(s.opacity,1),url:u,sourceUrl:u,radius:rad||undefined,imageScaleMode:String(s.objectFit).toLowerCase()==='contain'?'FIT':'FILL',sectionId,stackPath:sp,zIndex:0,paintPhase:2,captureSafe:true,captureId:cap})}continue}
      if(e.matches('input,textarea,select')){let text=e.tagName==='SELECT'?(e.options&&e.selectedIndex>=0?String(e.options[e.selectedIndex].text||''):''):String(e.value||e.getAttribute('placeholder')||'');if(text.trim()){const ps=!e.value&&e.getAttribute('placeholder')?getComputedStyle(e,'::placeholder'):s,pl=num(s.paddingLeft)+num(s.borderLeftWidth),pr=num(s.paddingRight)+num(s.borderRightWidth),pt=num(s.paddingTop)+num(s.borderTopWidth),fs=num(s.fontSize,16),lh=s.lineHeight==='normal'?fs*1.2:num(s.lineHeight,fs*1.2),x=round(b.x+pl),y=round(b.y+Math.max(pt,(b.height-lh)/2)),w=Math.max(1,round(b.width-pl-pr));add({kind:'text',name:name(e,' — поле'),x,y,absX:x,absY:y,width:w,height:Math.max(lh,1),opacity:num(s.opacity,1),fill:{kind:'solid',color:color(ps.color||s.color)},text:text.replace(/\s+/g,' ').trim(),expectedLineCount:1,textRole:'Body',fontSize:fs,fontWeight:num(s.fontWeight,400),fontFamily:String(s.fontFamily||'Inter').split(',')[0].replace(/^['"]|['"]$/g,''),fontStyle:String(s.fontStyle||'normal'),lineHeight:lh,letterSpacing:s.letterSpacing==='normal'?0:num(s.letterSpacing),textAlign:'LEFT',textSizing:'FIXED',sectionId,stackPath:sp,zIndex:0,paintPhase:3})}}
      const bgUrls=urls(s.backgroundImage);for(const u of bgUrls.slice(0,1)){const cap='bg-'+(bgSeq++);try{e.setAttribute('data-h2f-bg-capture',cap)}catch{}add({kind:'image',name:name(e,' — фон'),...b,absX:b.x,absY:b.y,opacity:num(s.opacity,1),url:u,sourceUrl:u,radius:rad||undefined,imageScaleMode:String(s.backgroundSize).includes('contain')?'FIT':'FILL',sectionId,stackPath:sp,zIndex:0,paintPhase:0,captureSafe:true,captureId:cap,captureMode:'background'})}
      const isSection=sectionMap.has(e);if(!isSection&&(bg||bw>.1||sh)){add({kind:'shape',name:name(e,' — плашка'),...b,absX:b.x,absY:b.y,opacity:num(s.opacity,1),fill:bg,stroke:bw>.1?borderColor(s):undefined,strokeWeight:bw||undefined,radius:rad||undefined,shadow:sh||undefined,sectionId,stackPath:sp,zIndex:0,paintPhase:0})}
    }
    const bottoms=sections.map(s=>s.y+s.height);for(const l of layers)bottoms.push(Number(l.absY??l.y)+Number(l.height||0));const height=Math.min(maxHeight,Math.max(1,...bottoms));
    return {width:viewportWidth,height,sections,layers,truncated,rendererVersion:20,framework:'elementor',popupSuppression:true,logicalText:true};
  }, { maxLayers:MAX_LAYERS, maxHeight:MAX_HEIGHT, viewportWidth:width });
}

async function renderElementor(rawUrl, width, options={}) {
  const { browser, page } = await openElementorPage(rawUrl, width);
  try {
    await prepareElementor(page);
    const snapshot = await collectElementor(page, width);
    if (!snapshot.layers.length) throw new Error('После рендера Elementor не найдено видимых слоёв');
    if (Array.isArray(options.captureClips) && options.captureClips.length) {
      const captures=[];
      for(const item of options.captureClips.slice(0,48)){
        const id=String(item&&item.id||''),captureId=String(item&&item.captureId||'');
        try{const attr=String(item&&item.captureMode||'element')==='background'?'data-h2f-bg-capture':'data-h2f-capture';const h=await page.$(`[${attr}="${captureId}"]`);if(!h)throw new Error('Элемент для снимка не найден');const box=await h.boundingBox();if(!box||box.width>.5===false||box.height>.5===false||box.width>4096||box.height>4096)throw new Error('Недопустимый размер элемента');const buf=await h.screenshot({type:'png'});captures.push({id,dataBase64:Buffer.from(buf).toString('base64')});await h.dispose().catch(()=>{})}catch(e){captures.push({id,error:e&&e.message?e.message:String(e)})}
      }
      return { finalUrl:page.url(), captures, snapshot };
    }
    let referenceBuffer=null;
    if(options.reference===true){const h=Math.max(1,Math.min(snapshot.height,30000));referenceBuffer=await page.screenshot({type:'webp',quality:84,clip:{x:0,y:0,width,height:h},captureBeyondViewport:true})}
    return { finalUrl:page.url(), snapshot, referenceBuffer };
  } finally { await browser.close().catch(()=>{}); }
}

module.exports = async function handler(req,res){
  cors(res);
  if(req.method==='OPTIONS')return res.status(204).end();
  if(!['GET','POST'].includes(req.method))return res.status(405).json({ok:false,error:'Разрешены только GET, POST и OPTIONS'});
  if(req.method==='GET'&&String(req.query&&req.query.ping||'')==='1')return res.status(200).json({ok:true,service:'browser-renderer',version:20,stableTilda:true,elementorMode:true,popupSuppression:true,logicalText:true,visualQa:true});
  let body=req.body;if(typeof body==='string'){try{body=JSON.parse(body)}catch{body={}}}if(!body||typeof body!=='object')body={};
  const raw=req.method==='POST'?(Array.isArray(body.url)?body.url[0]:body.url):(Array.isArray(req.query.url)?req.query.url[0]:req.query.url);
  const rawWidth=req.method==='POST'?(Array.isArray(body.width)?body.width[0]:body.width):(Array.isArray(req.query.width)?req.query.width[0]:req.query.width);
  const width=Math.max(320,Math.min(1920,Number(rawWidth)||1440));if(!raw)return res.status(400).json({ok:false,error:'Не передан параметр url'});
  try{
    const isElem=await detectElementor(String(raw));
    if(!isElem){const result=await mockRun(render17,req);if(result.statusCode===200&&result.kind==='json'&&result.body&&result.body.snapshot){const sn=postprocessStable(result.body.snapshot);return res.status(200).json({...result.body,mode:'browser-snapshot-v20-stable',snapshot:sn,stats:{...(result.body.stats||{}),layers:sn.layers.length,rendererVersion:20,popupSuppression:true,logicalText:true}})}return forward(result,res)}
    const capture=req.method==='POST'&&String(body.mode||'')==='capture-clips';const reference=req.method==='GET'&&String(req.query.reference||'')==='1';const result=await renderElementor(String(raw),width,{captureClips:capture?(Array.isArray(body.clips)?body.clips:[]):undefined,reference});
    if(capture)return res.status(200).json({ok:true,finalUrl:result.finalUrl,captures:result.captures||[]});
    if(reference&&result.referenceBuffer){res.setHeader('Content-Type','image/webp');return res.status(200).send(result.referenceBuffer)}
    return res.status(200).json({ok:true,mode:'browser-snapshot-v20-elementor',finalUrl:result.finalUrl,snapshot:result.snapshot,stats:{layers:result.snapshot.layers.length,sections:result.snapshot.sections.length,truncated:!!result.snapshot.truncated,imageLayers:result.snapshot.layers.filter(x=>x.kind==='image').length,framework:'elementor'}});
  }catch(e){return res.status(500).json({ok:false,error:e&&e.message?e.message:String(e)})}
};
