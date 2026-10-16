const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{pathToFileURL}=require('node:url');
const script=import('../scripts/deploy.mjs');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'animatus-dxf-deploy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),output=path.join(root,'release');await fs.mkdir(source);
 await fs.writeFile(path.join(source,'worker.cjs'),'module.exports = {};');
 await fs.writeFile(path.join(source,'animatus-module.json'),JSON.stringify({apiVersion:1,id:'dxf-packing',name:'DXF-Berechnung',version:'1.7.1',entry:'worker.cjs',operations:['pack-v3'],platforms:['linux'],architectures:['x64']}));
 const packages=JSON.parse(await fs.readFile(path.resolve(__dirname,'../../module-marketplace/.temp/system-packages/packages.json')));
 const template={id:'dxf-packing',online:packages.find(item=>item.id==='dxf-editor-online'),marketplace:{name:'DXF Editor'}};
 const {prepareDeployment}=await script;const descriptor=prepareDeployment({source,output,template});return {root,source,output,template,descriptor};
}
test('deploy publishes an existing platform package and verifies public bytes without a build',async t=>{
 const f=await fixture(t),{deploy}=await script;let publications=0;
 const fetchImpl=async url=>String(url).endsWith('/catalog.txt')?Response.json({modules:[f.descriptor]}):new Response(await fs.readFile(path.join(f.output,'files',f.descriptor.files.find(file=>file.url===String(url)).path)));
 const result=await deploy(['--','--no-build','--release='+f.output],{fetchImpl,publish:async prepared=>{publications++;assert.equal(prepared.catalog.modules.length,1);assert.deepEqual(prepared.catalog.modules[0].platforms,['linux']);assert.equal(prepared.assets.length,f.descriptor.files.length);}});
 assert.equal(publications,1);assert.equal(result.descriptor.version,'1.7.1');
});
test('changed prepared files abort before publishing',async t=>{
 const f=await fixture(t),{deploy}=await script;await fs.writeFile(path.join(f.output,'files/worker.cjs'),'changed');let calls=0;
 await assert.rejects(deploy(['--no-build','--release='+f.output],{publish:async()=>calls++}),/nach dem Build verändert/);assert.equal(calls,0);
});
test('deployment code supports a separate module checkout with an explicit shared-tooling path',async t=>{
 const f=await fixture(t),previous=process.env.ANIMATUS_MODULES_ROOT;t.after(()=>{if(previous===undefined)delete process.env.ANIMATUS_MODULES_ROOT;else process.env.ANIMATUS_MODULES_ROOT=previous;});
 process.env.ANIMATUS_MODULES_ROOT=path.resolve(__dirname,'../../..');
 await fs.copyFile(path.resolve(__dirname,'../scripts/deploy.mjs'),path.join(f.root,'deploy.mjs'));
 await fs.copyFile(path.resolve(__dirname,'../scripts/build-platform.mjs'),path.join(f.root,'build-platform.mjs'));
 const relocated=await import(pathToFileURL(path.join(f.root,'deploy.mjs')));
 const result=relocated.prepareDeployment({source:f.source,output:path.join(f.root,'relocated-release'),template:f.template});assert.equal(result.id,'dxf-packing');
});

test('prepared Mac modules can deploy from another platform but wrong Mac architectures are rejected',async t=>{
 const f=await fixture(t),{prepareDeployment,validateDeployment}=await script;
 const header=Buffer.alloc(8);header.writeUInt32LE(0xfeedfacf);header.writeUInt32LE(0x0100000c,4);
 const manifest=JSON.parse(await fs.readFile(path.join(f.source,'animatus-module.json')));manifest.platforms=['darwin'];manifest.architectures=['arm64'];manifest.nesting={platform:'darwin',architecture:'arm64'};
 await fs.writeFile(path.join(f.source,'animatus-module.json'),JSON.stringify(manifest));for(const name of ['animatus-nesting','dxf-raster-packer'])await fs.writeFile(path.join(f.source,name),header);
 const output=path.join(f.root,'mac-release'),descriptor=prepareDeployment({source:f.source,output,template:f.template});await validateDeployment(output,descriptor);
 header.writeUInt32LE(0x01000007,4);await fs.writeFile(path.join(f.source,'animatus-nesting'),header);
 const badOutput=path.join(f.root,'wrong-arch'),bad=prepareDeployment({source:f.source,output:badOutput,template:f.template});await assert.rejects(validateDeployment(badOutput,bad),/keine passende macOS/);
});

test('deploy builds before catalog lookup and publication; a failed build never publishes',async t=>{
 const {deploy}=await script;let uploads=0,lookups=0;
 await assert.rejects(deploy([],{build:async()=>{throw Error('build failed');},fetchImpl:async()=>{lookups++;},publish:async()=>uploads++}),/build failed/);assert.equal(uploads,0);assert.equal(lookups,0);
 const f=await fixture(t),events=[],downloads=new Map();let descriptor;
 const result=await deploy([],{sourceDirectory:f.source,build:async()=>{events.push('build');await fs.writeFile(path.join(f.source,'worker.cjs'),'fresh build');},publish:async prepared=>{events.push('publish');descriptor=prepared.catalog.modules[0];for(const file of descriptor.files)downloads.set(file.url,prepared.assets.find(asset=>asset.key.endsWith('/'+file.path+'.bin')).body);assert.equal(prepared.assets.find(asset=>asset.key.endsWith('/worker.cjs.bin')).body.toString(),'fresh build');},fetchImpl:async url=>{
  if(String(url).endsWith('/catalog.txt'))return Response.json({modules:[descriptor||f.template]});
  return new Response(downloads.get(String(url)));
 }});
 t.after(()=>fs.rm(result.output,{recursive:true,force:true}));assert.deepEqual(events,['build','publish']);
});

test('native module build supports all target platforms and refuses cross-platform compilation',async()=>{
 const {buildModule}=await import('../scripts/build-platform.mjs');
 for(const platform of ['darwin','win32','linux']){let calls=0;buildModule(platform,{host:platform,run:(_node,args)=>{calls++;assert.ok(args.includes('--native'));}});assert.equal(calls,1);assert.throws(()=>buildModule(platform,{host:'other',run:()=>{throw Error('must not execute');}}),/Zielsystem/);}
});
