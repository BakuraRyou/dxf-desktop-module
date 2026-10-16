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
