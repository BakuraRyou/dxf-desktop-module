const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
test('pinned engine and protocol sources are complete regular files inside this package',()=>{
 const sources=JSON.parse(fs.readFileSync(path.join(root,'vendor/sources.json')));
 for(const file of sources.files){
  const absolute=path.resolve(root,file.path),relative=path.relative(root,absolute);
  assert.ok(relative && !relative.startsWith('..'+path.sep));
  assert.ok(fs.lstatSync(absolute).isFile());
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),file.sha256,file.path);
 }
 for(const crate of ['native/raster-packer','native/sparrow'])for(const filename of ['Cargo.toml','Cargo.lock'])assert.ok(fs.existsSync(path.join(root,crate,filename)));
});
test('native build resolves cargo through PATH or an explicit CARGO override and reports missing tooling',async()=>{
 const {requireCargo}=await import('../scripts/rust-toolchain.mjs');
 let command;
 requireCargo({env:{},run:(file,args)=>{command=file;assert.deepEqual(args,['--version']);return {status:0};}});
 assert.equal(command,process.platform==='win32'?'cargo.exe':'cargo');
 assert.equal(requireCargo({env:{CARGO:'/toolchain/cargo'},run:()=>({status:0})}),'/toolchain/cargo');
 assert.throws(()=>requireCargo({env:{},run:()=>({error:Error('missing')})}),/Rust >= 1.90/);
});
