const {createHash}=require('node:crypto');
const {validateSchemas}=require('./mysql-schema.cjs');
const {validateSource}=require('./source-manifest.cjs');
const CATALOG='https://marktplatz.animatus.de/api/file/static/files/marketplace/catalog.txt';
const sha=body=>createHash('sha256').update(body).digest('hex');
function validateSystemPackage(value){
 if(!value||!/^([a-z][a-z0-9-]{1,63})$/.test(value.id)||typeof value.version!=='string'||!Array.isArray(value.artifacts)||!value.artifacts.length||value.artifacts.length>2048||!Array.isArray(value.components)||value.components.length>200||!Array.isArray(value.pages)||value.pages.length>20)throw new Error('Ungültiges Systempaket.');
 if(value.configuration!==undefined&&(!Array.isArray(value.configuration)||value.configuration.length>32||value.configuration.some(key=>typeof key!=='string'||!/^DB_(PROVIDER|NAME)$/.test(key))))throw new Error('Ungültige Systemvoraussetzungen.');
 const seen=new Set();let total=0;
 if(value.schemas!==undefined)validateSchemas(value.schemas);
 if(value.source!==undefined)validateSource(value.source);
 for(const a of value.artifacts){
  const url=new URL(a.url);if(url.origin!=='https://marktplatz.animatus.de'||!url.pathname.startsWith('/api/file/static/files/marketplace/online/')||url.username||url.password||url.search||url.hash||!/^([a-f0-9]{64})$/.test(a.sha256)||!Number.isSafeInteger(a.bytes)||a.bytes<0||a.bytes>32*1024*1024||seen.has(a.key)||!/^modules\/(private-components\/[a-f0-9]{64}\.(js|css)|routes\/[a-zA-Z0-9_./-]+\.min\.js)$/.test(a.key)||a.key.split('/').some(s=>!s||s==='.'||s==='..'))throw new Error('Ungültige Paketdatei.');
  seen.add(a.key);total+=a.bytes;
  if(a.key.startsWith('modules/private-components/')&&!a.key.includes('/'+a.sha256+'.'))throw new Error('Ungültige Komponenten-Prüfsumme.');
 }
 if(total>512*1024*1024)throw new Error('Das Systempaket ist zu groß.');
 for(const c of value.components){if(typeof c.name!=='string')throw new Error('Ungültige Komponente.');for(const key of ['path','css'])if(c[key]){const match=/^\/api\/module-assets\?asset=([a-f0-9]{64}\.(?:js|css))$/.exec(c[key]);if(!match||!seen.has('modules/private-components/'+match[1]))throw new Error('Unvollständige Komponente.');}}
 for(const p of value.pages)if(!/^(app|admin)\/[a-z0-9/-]+\/index\.json$/.test(p.key)||p.key.includes('..')||!p.value?.root||!Array.isArray(p.value.content)||p.value.content.some(c=>!value.components.some(e=>e.name===c.type)))throw new Error('Ungültige Paketseite.');
 return value;
}
async function readBytes(response,limit){
 if(!response.ok||!response.body)throw new Error('Die Paketquelle ist nicht erreichbar.');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw new Error('Die Paketdatei ist größer als angegeben.');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
 return Buffer.concat(chunks);
}
class SystemPackages{
 constructor({fetch=globalThis.fetch,read,write,activate,snapshot,configuration=(/** @type {string[]} */ _keys)=>[],initialize=async(/** @type {any[]} */ _schemas)=>{},withMutation=async run=>run(),invalidate=()=>{}}){Object.assign(this,{fetch,read,write,activate,snapshot,configuration,initialize,withMutation,invalidate});this.pending=false;}
 async catalog(){const bytes=await readBytes(await this.fetch(CATALOG,{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)}),4*1024*1024);const catalog=JSON.parse(bytes);return (catalog.modules||[]).map(m=>m.online).filter(Boolean).map(validateSystemPackage);}
 async status(){const installed=await this.read('settings/marketplace/installed.json')||{};const packages=await this.catalog();return {packages:packages.map(p=>({id:p.id,name:p.name,version:p.version,installedVersion:installed[p.id]?.version||null,configuration:this.configuration(p.configuration||[]),pages:p.pages.map(x=>'/'+x.key.replace(/\/index.json$/,''))}))};}
 async install(id){
  if(this.pending)throw new Error('Eine Systeminstallation läuft bereits.');this.pending=true;
  try{return await this.withMutation(async()=>{
   const release=(await this.catalog()).find(p=>p.id===id);if(!release)throw new Error('Dieses Systempaket ist nicht im offiziellen Marktplatz verfügbar.');
   const missing=this.configuration(release.configuration||[]);if(missing.length)throw new Error('Richte zuerst die benötigten Systemverbindungen ein: '+missing.join(', '));
   const revision=await this.snapshot();const contents=new Map();
   // Verify every byte before changing the active system or writing any page.
   for(const a of release.artifacts){const body=await readBytes(await this.fetch(a.url,{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)}),a.bytes);if(body.length!==a.bytes||sha(body)!==a.sha256)throw new Error('Die Paketprüfung ist fehlgeschlagen.');contents.set(a.key,body);}
   const existing=await this.read('settings/modules/components.json')||[];if(!Array.isArray(existing))throw new Error('Die Komponentenregistrierung ist ungültig.');
   const names=new Set(release.components.map(c=>c.name));const registry=Buffer.from(JSON.stringify([...existing.filter(c=>!names.has(c.name)),...release.components]));
   const artifacts=[...release.artifacts.map(a=>({key:a.key,sha256:a.sha256})),{key:'settings/modules/components.json',sha256:sha(registry)}];contents.set('settings/modules/components.json',registry);
   await this.initialize(release.schemas||[]);
   await this.activate(artifacts,a=>contents.get(a.key),revision);
   // Pages are seeded only; user edits survive updates.
   for(const p of release.pages)if(!await this.read(p.key))await this.write(p.key,JSON.stringify(p.value));
   await this.write('settings/modules/components.json',registry.toString());
   const installed=await this.read('settings/marketplace/installed.json')||{};
   await this.write('settings/marketplace/installed.json',JSON.stringify({...installed,[id]:{version:release.version,revision:release.revision,installedAt:new Date().toISOString(),manifest:release}}));
   await this.invalidate();return {installed:true,id,version:release.version};
  });}finally{this.pending=false;}
 }
}
module.exports={SystemPackages,validateSystemPackage,readBytes};
