#!/usr/bin/env node
import fs from 'node:fs';
import {buildModule} from './build-platform.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(import.meta.url);
const BASE='https://marktplatz.animatus.de/api/file/static/files/marketplace/modules/';
const CATALOG='https://marktplatz.animatus.de/api/file/static/files/marketplace/catalog.txt';
const sha=body=>createHash('sha256').update(body).digest('hex');
function tooling(){
 return {packageModule:require('../sdk/package-module.cjs').packageModule,...require('../sdk/module-installation.cjs'),...require('../sdk/system-packages.cjs'),site:require('./publisher.cjs')};
}
export function prepareDeployment({source,output,template}){
 const {packageModule,validateSystemPackage}=tooling();
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'animatus-module.json')));
 if(manifest.id!=='dxf-packing'||template?.id!=='dxf-packing'||!template.online)throw Error('DXF-Build oder offizielles DXF-Angebot fehlt.');
 validateSystemPackage(template.online);
 if(fs.existsSync(output))throw Error('Der Paketordner existiert bereits und wird nicht überschrieben.');
 const release=packageModule(source,BASE+'dxf-packing/',output);
 const revision=sha(JSON.stringify(release.files.map(({path,sha256,bytes})=>({path,sha256,bytes}))));
 for(const file of release.files)file.url=new URL(`dxf-packing/${encodeURIComponent(release.version)}/${revision}/${file.path}.bin`,BASE).href;
 const online=template.online;
 const descriptor={...release,marketplace:template.marketplace,online,requirements:[{id:online.id,name:online.name,version:online.version}]};
 fs.writeFileSync(path.join(output,'catalog-entry.json'),JSON.stringify(descriptor,null,2)+'\n');
 return descriptor;
}
export async function validateDeployment(output,descriptor){
 const {validatePackage,validateSystemPackage}=tooling();validatePackage(descriptor);validateSystemPackage(descriptor.online);
 if(fs.lstatSync(path.join(output,'files')).isSymbolicLink())throw Error('Symbolische Links sind im Paket nicht erlaubt.');
 const manifest=JSON.parse(fs.readFileSync(path.join(output,'files/animatus-module.json')));
 if(descriptor.id!=='dxf-packing'||manifest.id!==descriptor.id||manifest.version!==descriptor.version||JSON.stringify(manifest.platforms)!==JSON.stringify(descriptor.platforms)||JSON.stringify(manifest.architectures)!==JSON.stringify(descriptor.architectures))throw Error('Paket und Plattformbeschreibung passen nicht zusammen.');
 for(const file of descriptor.files){
  const relative=file.path.split('/');let current=path.join(output,'files');
  for(const part of relative){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('Symbolische Links sind im Paket nicht erlaubt.');}
  const body=fs.readFileSync(current);if(body.length!==file.bytes||sha(body)!==file.sha256)throw Error('Das Paket wurde nach dem Build verändert: '+file.path);
  const url=new URL(file.url);if(url.origin!=='https://marktplatz.animatus.de'||!url.pathname.startsWith('/api/file/static/files/marketplace/modules/dxf-packing/')||url.search||url.hash)throw Error('Unzulässige Paketquelle.');
 }
 if(descriptor.platforms?.includes('darwin')){
  const {verifyMacBinary}=await import('./release-mac.mjs');
  if(descriptor.platforms.length!==1||descriptor.architectures?.length!==1)throw Error('Native Mac-Pakete benötigen eine eindeutige Architektur.');
  if(manifest.nesting?.platform!=='darwin'||manifest.nesting?.architecture!==descriptor.architectures[0])throw Error('Der native Mac-Rechenkern passt nicht zur Paketbeschreibung.');
  for(const file of ['animatus-nesting','dxf-raster-packer'])verifyMacBinary(fs.readFileSync(path.join(output,'files',file)),descriptor.architectures[0]);
 }
}
export async function deploy(args=process.argv.slice(2),{fetchImpl=fetch,publish,build=buildModule,sourceDirectory=path.join(root,'dist')}={}){
 args=args.filter(arg=>arg!=='--');
 if(args.includes('--help')){console.log('Im DXF-Modul: pnpm run deploy\nBaut das native Modul für dieses Betriebssystem und veröffentlicht es.\nBuild und Upload: deploy:mac | deploy:win | deploy:linux\nNur vorhandenes Paket veröffentlichen: pnpm run publish -- --release=PAKETORDNER\nOptionen: --no-build, --platform=darwin|win32|linux, --host-root=KONFIGORDNER\nDeployment: lokale .env.deploy und GOOGLE_APPLICATION_CREDENTIALS oder gcloud.json konfigurieren.');return;}
 if(args.some(arg=>arg!=='--no-build'&&!arg.startsWith('--platform=')&&!arg.startsWith('--release=')&&!arg.startsWith('--host-root=')))throw Error('Unbekannte Option. Nutze --help.');
 const {site,readBytes}=tooling();
 const hostArg=args.find(arg=>arg.startsWith('--host-root='));
 const hostRoot=hostArg?path.resolve(hostArg.slice(12)):site.defaultHost;
 const releaseArg=args.find(arg=>arg.startsWith('--release='));
 if(releaseArg&&!args.includes('--no-build'))throw Error('Für ein bereits vorbereitetes Paket pnpm run publish -- --release=PFAD verwenden.');
 if(!args.includes('--no-build'))await build(args.find(arg=>arg.startsWith('--platform='))?.slice(11)||process.platform);
 let output,descriptor;
 if(releaseArg){
  output=path.resolve(releaseArg.slice(10));
  descriptor=JSON.parse(fs.readFileSync(path.join(output,'catalog-entry.json')));
 }else{
  const source=sourceDirectory;
  if(!fs.existsSync(path.join(source,'animatus-module.json')))throw Error('In dist/ fehlt der Build. Führe zuerst pnpm run build oder auf dem Mac pnpm run build:mac aus.');
  const response=await fetchImpl(CATALOG,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
  const catalog=JSON.parse(await readBytes(response,4*1024*1024));
  const template=catalog.modules?.find(item=>item.id==='dxf-packing'&&item.online);
  const parent=path.join(root,'.temp/releases');fs.mkdirSync(parent,{recursive:true});
  output=path.join(parent,'deploy-'+Date.now());descriptor=prepareDeployment({source,output,template});
 }
 const target=args.find(arg=>arg.startsWith('--platform='))?.slice(11);
 if(target&&!descriptor.platforms?.includes(target))throw Error('Der Build passt nicht zum gewählten Zielsystem.');
 await validateDeployment(output,descriptor);
 const assets=descriptor.files.map(file=>({key:'files/marketplace/modules/'+site.catalogTarget(file),body:fs.readFileSync(path.join(output,'files',file.path))}));
 await (publish||site.publishSite)({hostRoot,catalog:{modules:[descriptor]},assets});
 // The activation must retain exactly this platform variant; other variants stay registered.
 const response=await fetchImpl(CATALOG,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
 const catalog=JSON.parse(await readBytes(response,4*1024*1024));
 const installed=catalog.modules?.find(item=>item.id===descriptor.id&&JSON.stringify(item.platforms)===JSON.stringify(descriptor.platforms)&&JSON.stringify(item.architectures)===JSON.stringify(descriptor.architectures));
 if(!installed||JSON.stringify(installed.files)!==JSON.stringify(descriptor.files))throw Error('Die veröffentlichte Plattformvariante konnte nicht bestätigt werden.');
 for(const file of descriptor.files){const response=await fetchImpl(file.url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(120000)});const body=await readBytes(response,file.bytes);if(body.length!==file.bytes||sha(body)!==file.sha256)throw Error('Die veröffentlichte Datei stimmt nicht: '+file.path);}
 console.log('DXF-Modul veröffentlicht und geprüft: '+(descriptor.platforms?.join(', ')||'plattformunabhängig')+' / '+(descriptor.architectures?.join(', ')||'alle Architekturen'));
 return {output,descriptor};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))deploy().catch(error=>{console.error(error.code==='ENOENT'?'Build, Paketordner oder Deployment-Konfiguration fehlt. Nutze --help.':error.message);process.exitCode=1;});
