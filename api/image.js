const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_BYTES = 24 * 1024 * 1024;
const TIMEOUT_MS = 18000;
const MAX_REDIRECTS = 5;
const MAX_DIMENSION = 4096;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function isPrivateV4(ip) {
  const p=String(ip||'').split('.').map(Number); if(p.length!==4||p.some(x=>!Number.isInteger(x)||x<0||x>255))return true; const[a,b]=p;
  return a===0||a===10||a===127||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===198&&(b===18||b===19))||a>=224;
}
function isPrivateV6(ip){const s=String(ip||'').toLowerCase().split('%')[0];if(s==='::'||s==='::1'||s.startsWith('fc')||s.startsWith('fd')||/^fe[89ab]/.test(s))return true;if(s.startsWith('::ffff:')){const v4=s.slice(7);return net.isIP(v4)===4?isPrivateV4(v4):true}return false}
function isPrivateIp(ip){const t=net.isIP(ip);return t===4?isPrivateV4(ip):t===6?isPrivateV6(ip):true}
const dnsCache=new Map();
async function assertPublic(raw){let u;try{u=new URL(raw)}catch{throw new Error('Некорректный URL изображения')}if(!['http:','https:'].includes(u.protocol))throw new Error('Недопустимый протокол');if(u.username||u.password)throw new Error('URL с логином/паролем запрещён');const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();if(!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local'))throw new Error('Локальный адрес запрещён');if(net.isIP(host)){if(isPrivateIp(host))throw new Error('Приватный IP запрещён');return u}let p=dnsCache.get(host);if(!p){p=Promise.all([dns.resolve4(host).catch(()=>[]),dns.resolve6(host).catch(()=>[])]).then(([a,b])=>{const all=[...a,...b];return all.length>0&&!all.some(isPrivateIp)});dnsCache.set(host,p)}if(!(await p))throw new Error('Адрес изображения не является публичным');return u}
async function readLimited(response){const declared=Number(response.headers.get('content-length')||0);if(declared>MAX_BYTES)throw new Error('Изображение слишком большое');const ab=Buffer.from(await response.arrayBuffer());if(ab.length>MAX_BYTES)throw new Error('Изображение слишком большое');return ab}

async function oneFetch(url, referer, uaVariant) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  try {
    return await fetch(url.href,{redirect:'manual',signal:controller.signal,headers:{
      'User-Agent': uaVariant===2?'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
      'Accept':'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      ...(referer?{'Referer':referer}:{}),
    }});
  } finally { clearTimeout(timer) }
}
async function fetchImage(raw, pageRef){
  let current=await assertPublic(raw); const refs=[];
  if(pageRef){try{const r=await assertPublic(pageRef);refs.push(r.href,r.origin+'/')}catch{}}
  refs.push(current.origin+'/', '');
  let last='';
  for(let redirect=0;redirect<=MAX_REDIRECTS;redirect++){
    let response=null;
    for(const ref of Array.from(new Set(refs))){
      for(const ua of [1,2]){
        try{response=await oneFetch(current,ref,ua)}catch(e){last=e&&e.message?e.message:String(e);continue}
        if([301,302,303,307,308].includes(response.status))break;
        if(response.ok)break;
        last=`HTTP ${response.status}`; response=null;
      }
      if(response&&response.ok)break;
      if(response&&[301,302,303,307,308].includes(response.status))break;
    }
    if(!response)continue;
    if([301,302,303,307,308].includes(response.status)){
      const loc=response.headers.get('location');if(!loc||redirect===MAX_REDIRECTS)throw new Error('Слишком много перенаправлений');current=await assertPublic(new URL(loc,current).href);continue;
    }
    if(!response.ok){last=`HTTP ${response.status}`;continue}
    let type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();const body=await readLimited(response);
    if(!type.startsWith('image/')){
      if(body[0]===0x89&&body.slice(1,4).toString()==='PNG')type='image/png';
      else if(body[0]===0xff&&body[1]===0xd8)type='image/jpeg';
      else if(body.slice(0,4).toString()==='RIFF')type='image/webp';
      else if(body.slice(0,5).toString().toLowerCase().includes('<svg'))type='image/svg+xml';
      else throw new Error(`Источник вернул не изображение: ${type||'неизвестный тип'}`);
    }
    return{type,body,finalUrl:current.href};
  }
  throw new Error(`Не удалось загрузить изображение${last?`: ${last}`:''}`);
}
async function normalizeToPng(body,contentType){let mod;try{mod=await import('sharp')}catch(e){throw new Error(`Не удалось загрузить модуль конвертации: ${e&&e.message?e.message:e}`)}const sharp=mod.default||mod;let p=sharp(body,{failOn:'none',animated:false,density:contentType==='image/svg+xml'?192:72,limitInputPixels:120_000_000}).rotate();const meta=await p.metadata(),w=Number(meta.width||0),h=Number(meta.height||0);if(!w||!h)throw new Error('Не удалось определить размер изображения');if(w>MAX_DIMENSION||h>MAX_DIMENSION)p=p.resize({width:Math.min(w,MAX_DIMENSION),height:Math.min(h,MAX_DIMENSION),fit:'inside',withoutEnlargement:true});const out=await p.png({compressionLevel:8,adaptiveFiltering:true}).toBuffer({resolveWithObject:true});return{body:out.data,width:out.info.width,height:out.info.height,sourceWidth:w,sourceHeight:h}}

module.exports=async function handler(req,res){cors(res);if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='GET')return res.status(405).json({ok:false,error:'Разрешён только GET'});const raw=Array.isArray(req.query.url)?req.query.url[0]:req.query.url,ref=Array.isArray(req.query.ref)?req.query.ref[0]:req.query.ref;if(!raw)return res.status(400).json({ok:false,error:'Не передан параметр url'});try{const src=await fetchImage(String(raw),ref?String(ref):'');const n=await normalizeToPng(src.body,src.type);res.setHeader('Content-Type','image/png');res.setHeader('Cache-Control','public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');res.setHeader('X-Source-Type',src.type);res.setHeader('X-Image-Width',String(n.width));res.setHeader('X-Image-Height',String(n.height));return res.status(200).send(n.body)}catch(e){return res.status(502).json({ok:false,error:e&&e.message?e.message:'Не удалось загрузить изображение'})}};
