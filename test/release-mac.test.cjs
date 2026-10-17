const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const script=import('../scripts/release-mac.mjs');
async function fixture(t,arch='arm64'){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'animatus-mac-release-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source');await fs.mkdir(source);
 const header=Buffer.alloc(8);header.writeUInt32LE(0xfeedfacf);header.writeUInt32LE(arch==='arm64'?0x0100000c:0x01000007,4);
 for(const file of ['animatus-nesting','dxf-raster-packer']){await fs.writeFile(path.join(source,file),header);await fs.chmod(path.join(source,file),0o755);}
 await fs.writeFile(path.join(source,'worker.cjs'),'module.exports = {};');
 await fs.writeFile(path.join(source,'animatus-module.json'),JSON.stringify({apiVersion:1,id:'dxf-packing',name:'DXF-Berechnung',version:'1.7.1',entry:'worker.cjs',operations:['pack-v2','pack-v3'],platforms:['darwin'],architectures:[arch],nesting:{platform:'darwin',architecture:arch}}));
 const releases=[require('./fixtures/online-package.cjs')];
 return {source,output:path.join(root,'release'),arch,template:{id:'dxf-packing',marketplace:{name:'DXF Editor'},online:releases.find(r=>r.id==='dxf-editor-online')}};
}
test('Linux and unsupported architectures fail before building or uploading',async()=>{const {requireMac}=await script;assert.throws(()=>requireMac('linux','x64'),/auf einem Mac/);assert.throws(()=>requireMac('darwin','ia32'));requireMac('darwin','arm64');requireMac('darwin','x64');});
test('macOS ARM and Intel releases retain online requirements and immutable verified package files',async t=>{
 const {prepareMacRelease}=await script;
 for(const arch of ['arm64','x64']){const f=await fixture(t,arch);const release=prepareMacRelease(f);assert.deepEqual(release.platforms,['darwin']);assert.deepEqual(release.architectures,[arch]);assert.equal(release.online.id,'dxf-editor-online');assert.equal(release.requirements[0].version,f.template.online.version);assert.ok(release.files.every(file=>file.url.startsWith('https://marktplatz.animatus.de/api/file/static/files/marketplace/modules/dxf-packing/1.7.1/')&&file.url.endsWith('.bin')));assert.equal(release.files.find(f=>f.path==='animatus-nesting').executable,true);assert.throws(()=>prepareMacRelease(f),/existiert bereits/);}
});
test('incorrect native binaries and wrong platform descriptors cannot be published as Mac packages',async t=>{
 const {prepareMacRelease,verifyMacBinary}=await script;assert.throws(()=>verifyMacBinary(Buffer.from('\x7fELFfake'),'arm64'),/keine passende macOS/);
 const f=await fixture(t);await fs.writeFile(path.join(f.source,'animatus-nesting'),Buffer.alloc(8));assert.throws(()=>prepareMacRelease(f),/keine passende macOS/);await assert.rejects(fs.stat(f.output),{code:'ENOENT'});
});


test('Mac release entry runs in an isolated checkout without marketplace or desktop folders',async t=>{
 const {pathToFileURL}=require('node:url');
 for(const arch of ['arm64','x64']) {
  const f=await fixture(t,arch),checkout=path.join(path.dirname(f.source),'standalone');
  await fs.mkdir(path.join(checkout,'scripts'),{recursive:true});
  await fs.cp(path.resolve(__dirname,'../sdk'),path.join(checkout,'sdk'),{recursive:true});
  for(const file of ['release-mac.mjs','publisher.cjs'])await fs.copyFile(path.resolve(__dirname,'../scripts',file),path.join(checkout,'scripts',file));
  const {main}=await import(pathToFileURL(path.join(checkout,'scripts/release-mac.mjs')));
  const events=[];
  const options={platform:'darwin',arch,sourceDirectory:f.source,outputRoot:path.join(checkout,'releases'),
   fetchImpl:async()=>{events.push('catalog');return Response.json({modules:[f.template]});},
   run:(_node,args,options)=>{events.push('build');assert.equal(args[0],path.join(checkout,'scripts/build.mjs'));assert.equal(args[1],'--native');assert.equal(path.resolve(options.cwd),checkout);},
   publish:async()=>{throw Error('Prepare-only must never publish');}};
  const prepared=await main(['--prepare-only'],options);
  assert.deepEqual(events,['catalog','build']);
  assert.deepEqual(prepared.descriptor.platforms,['darwin']);assert.deepEqual(prepared.descriptor.architectures,[arch]);
  assert.equal(JSON.parse(await fs.readFile(path.join(prepared.output,'release.json'))).architecture,arch);
  await assert.rejects(fs.access(path.join(checkout,'marktplatz')),{code:'ENOENT'});
  // Publishing uses that same prepared package and local configuration helper.
  // Only the external write is replaced, so no credentials or network are used.
  const publisher=require(path.join(checkout,'scripts/publisher.cjs'));
  const configuration=publisher.configuration;publisher.configuration=()=>{events.push('configuration');};
  t.after(()=>{publisher.configuration=configuration;});
  let uploads=0;
  await main([],{...options,publish:async request=>{uploads++;assert.equal(path.resolve(request.hostRoot),checkout);assert.deepEqual(request.descriptor.architectures,[arch]);}});
  assert.equal(uploads,1);assert.ok(events.includes('configuration'));
 }
});
