#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const root=fileURLToPath(new URL('..',import.meta.url));
const modulesRoot=root;
const {packageModule}=require('../sdk/package-module.cjs');
const {validateSystemPackage,readBytes}=require('../sdk/system-packages.cjs');
const CATALOG='https://marktplatz.animatus.de/api/file/static/files/marketplace/catalog.txt';
const BASE='https://marktplatz.animatus.de/api/file/static/files/marketplace/modules/';
const sha=body=>createHash('sha256').update(body).digest('hex');

export function requireMac(platform=process.platform,arch=process.arch){
 if(platform!=='darwin')throw Error('Diesen Befehl auf einem Mac ausführen. Native macOS-Rechenkerne werden auf dem Zielsystem gebaut.');
 if(!['arm64','x64'].includes(arch))throw Error('Unterstützt werden Apple Silicon (arm64) und Intel-Macs (x64).');
}
export function verifyMacBinary(body,arch){
 const cpu=arch==='arm64'?0x0100000c:arch==='x64'?0x01000007:undefined;
 if(!cpu||body.length<8||body.readUInt32LE(0)!==0xfeedfacf||body.readUInt32LE(4)!==cpu)throw Error('Der Rechenkern ist keine passende macOS-Datei für '+arch+'.');
}

export function prepareMacRelease({source,output,template,arch}){
 requireMac('darwin',arch);
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'animatus-module.json')));
 if(manifest.id!=='dxf-packing'||JSON.stringify(manifest.platforms)!=='["darwin"]'||JSON.stringify(manifest.architectures)!==JSON.stringify([arch])||manifest.nesting?.platform!=='darwin'||manifest.nesting?.architecture!==arch)throw Error('Das DXF-Paket enthält keinen passenden nativen Mac-Build.');
 for(const name of ['animatus-nesting','dxf-raster-packer'])verifyMacBinary(fs.readFileSync(path.join(source,name)),arch);
 if(template?.id!=='dxf-packing'||!template.online)throw Error('Das offizielle DXF-Angebot mit Systemfunktionen fehlt im Katalog.');
 const online=validateSystemPackage(template.online);
 if(fs.existsSync(output))throw Error('Der Ausgabeordner existiert bereits und wird nicht überschrieben.');
 const release=packageModule(source,BASE+'dxf-packing/',output);
 const revision=sha(JSON.stringify(release.files.map(({path,sha256,bytes})=>({path,sha256,bytes}))));
 for(const file of release.files)file.url=new URL(`dxf-packing/${encodeURIComponent(release.version)}/${revision}/${file.path}.bin`,BASE).href;
 const descriptor={...release,marketplace:template.marketplace,online,requirements:[{id:online.id,name:online.name,version:online.version}]};
 fs.writeFileSync(path.join(output,'catalog-entry.json'),JSON.stringify(descriptor,null,2)+'\n');
 fs.writeFileSync(path.join(output,'release.json'),JSON.stringify({platform:'darwin',architecture:arch,revision,moduleVersion:release.version,onlineVersion:online.version},null,2)+'\n');
 return descriptor;
}
export async function publishMacRelease({output,descriptor,hostRoot,fetchImpl=fetch}){
 // Revalidate the saved descriptor and every byte before publishing any catalog pointer.
 const manifest=JSON.parse(fs.readFileSync(path.join(output,'files/animatus-module.json')));
 const checked=prepareMacDescriptor(output,descriptor,manifest);
 const site=require('./publisher.cjs');
 await site.publishSite({hostRoot:hostRoot||site.defaultHost,catalog:{modules:[checked]},assets:checked.files.map(file=>({key:'files/marketplace/modules/'+site.catalogTarget(file),body:fs.readFileSync(path.join(output,'files',file.path))}))});
 const response=await fetchImpl(CATALOG,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
 const catalog=JSON.parse(await readBytes(response,4*1024*1024));
 const published=catalog.modules?.find(item=>item.id===checked.id&&JSON.stringify(item.platforms)===JSON.stringify(checked.platforms)&&JSON.stringify(item.architectures)===JSON.stringify(checked.architectures));
 if(!published||JSON.stringify(published.files)!==JSON.stringify(checked.files))throw Error('Die Veröffentlichung der Mac-Variante konnte nicht bestätigt werden.');
 for(const file of checked.files){const response=await fetchImpl(file.url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(120000)});const body=await readBytes(response,file.bytes);if(body.length!==file.bytes||sha(body)!==file.sha256)throw Error('Die veröffentlichte Moduldatei stimmt nicht: '+file.path);}
 console.log('DXF-Modul für macOS/'+checked.architectures[0]+' im Marktplatz veröffentlicht und vollständig geprüft.');
}
function prepareMacDescriptor(output,descriptor,manifest){
 requireMac('darwin',manifest.architectures?.[0]);
 if(manifest.id!=='dxf-packing'||JSON.stringify(manifest.platforms)!=='["darwin"]'||manifest.nesting?.platform!=='darwin'||manifest.nesting?.architecture!==manifest.architectures[0])throw Error('Ungültiger Mac-Installationsnachweis.');
 require('../sdk/module-installation.cjs').validatePackage(descriptor);
 if(descriptor.id!=='dxf-packing'||JSON.stringify(descriptor.platforms)!=='["darwin"]'||JSON.stringify(descriptor.architectures)!==JSON.stringify(manifest.architectures)||descriptor.version!==manifest.version)throw Error('Widersprüchliche Mac-Paketbeschreibung.');
 validateSystemPackage(descriptor.online);
 for(const file of descriptor.files){const body=fs.readFileSync(path.join(output,'files',file.path));if(sha(body)!==file.sha256||body.length!==file.bytes)throw Error('Das vorbereitete Paket wurde verändert: '+file.path);const url=new URL(file.url);if(url.origin!=='https://marktplatz.animatus.de'||!url.pathname.startsWith('/api/file/static/files/marketplace/modules/dxf-packing/'))throw Error('Unzulässige Paketquelle.');}
 for(const name of ['animatus-nesting','dxf-raster-packer'])verifyMacBinary(fs.readFileSync(path.join(output,'files',name)),manifest.architectures[0]);
 return descriptor;
}
export async function main(args=process.argv.slice(2)){
 args=args.filter(arg=>arg!=='--');
 if(args.includes('--help')){console.log('Im DXF-Modul auf dem Mac: pnpm run release:mac\nOptionen: --prepare-only, --host-root=PFAD\nBaut die Architektur dieses Macs und veröffentlicht die DXF-Variante im Animatus-Marktplatz.\nVoraussetzungen: Node >=22.12, installierte Projektabhängigkeiten, Rust >=1.90 und Xcode Command Line Tools.\nFür die Veröffentlichung werden eine lokale .env.deploy und Google-Zugangsdaten benötigt.');return;}
 if(args.some(arg=>arg!=='--prepare-only'&&!arg.startsWith('--host-root=')))throw Error('Unbekannte Option. Nutze --help.');
 requireMac();
 const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<12))throw Error('Node >=22.12 wird benötigt.');
 const site=require(path.join(modulesRoot,'marktplatz/scripts/site.cjs'));
 const hostRoot=path.resolve(args.find(arg=>arg.startsWith('--host-root='))?.slice(12)||site.defaultHost);
 if(!args.includes('--prepare-only'))site.configuration(hostRoot);
 const response=await fetch(CATALOG,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
 const catalog=JSON.parse(await readBytes(response,4*1024*1024));
 const template=catalog.modules?.find(item=>item.id==='dxf-packing'&&item.online);if(!template)throw Error('DXF-Angebot im Marktplatz nicht gefunden.');
 execFileSync(process.execPath,[path.join(root,'scripts/build.mjs'),'--native'],{cwd:modulesRoot,stdio:'inherit'});
 const parent=path.join(root,'.temp/releases');fs.mkdirSync(parent,{recursive:true});
 const output=path.join(parent,'darwin-'+process.arch+'-'+Date.now());
 const descriptor=prepareMacRelease({source:path.join(root,'dist'),output,template,arch:process.arch});
 console.log('Mac-Paket vorbereitet: '+output);
 if(!args.includes('--prepare-only'))await publishMacRelease({output,descriptor,hostRoot});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
