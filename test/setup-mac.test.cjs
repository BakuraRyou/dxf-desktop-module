const {test}=require('node:test');
const assert=require('node:assert/strict');

test('Mac setup installs official rustup and configures a project-scoped toolchain',async()=>{
  const {setupMac}=await import('../scripts/setup-mac.mjs');
  const calls=[];
  setupMac({platform:'darwin',env:{CARGO_HOME:'/local/cargo'},log:()=>{},run:(file,args)=>{
    calls.push([file,args]);
    return {status:file==='/local/cargo/bin/rustup'&&args[0]==='--version'?1:0};
  }});
  assert.ok(calls.some(([file,args])=>file==='curl'&&args.includes('https://sh.rustup.rs')&&args.includes('=https')));
  assert.ok(calls.some(([file,args])=>file==='sh'&&args.includes('--default-toolchain')&&args.includes('none')));
  assert.ok(calls.some(([file,args])=>file==='/local/cargo/bin/rustup'&&args.join(' ')==='toolchain install stable --profile minimal'));
  assert.ok(calls.some(([,args])=>args[0]==='override'&&args.includes('--path')));
  assert.ok(!calls.some(([,args])=>args[0]==='default'));
});

test('Mac setup reuses rustup without downloading the installer',async()=>{
  const {setupMac}=await import('../scripts/setup-mac.mjs');
  const calls=[];
  setupMac({platform:'darwin',log:()=>{},run:(file,args)=>{calls.push([file,args]);return {status:0};}});
  assert.ok(!calls.some(([file])=>file==='curl'||file==='sh'));
  assert.ok(calls.some(([,args])=>args.join(' ')==='run stable cargo --version'));
});

test('Mac setup stops for missing Apple build tools and rejects other operating systems',async()=>{
  const {setupMac}=await import('../scripts/setup-mac.mjs');
  const calls=[];
  assert.throws(()=>setupMac({platform:'darwin',run:(file,args)=>{calls.push([file,args]);return {status:args[0]==='-p'?1:0};}}),/schließe die Installation/);
  assert.deepEqual(calls,[['xcode-select',['-p']],['xcode-select',['--install']]]);
  assert.throws(()=>setupMac({platform:'linux',run:()=>assert.fail('must not run')}),/macOS/);
});

test('Mac setup stops after a failed download before executing the installer',async()=>{
  const {setupMac}=await import('../scripts/setup-mac.mjs');
  const calls=[];
  assert.throws(()=>setupMac({platform:'darwin',log:()=>{},run:(file,args)=>{
    calls.push(file);
    return {status:file==='curl'||args[0]==='--version'?1:0};
  }}),/curl/);
  assert.ok(!calls.includes('sh'));
});

test('native build finds a fresh rustup installation before shell PATH is refreshed',async()=>{
  const {requireCargo}=await import('../scripts/rust-toolchain.mjs');
  const calls=[];
  assert.equal(requireCargo({env:{CARGO_HOME:'/local/cargo'},run:(file)=>{calls.push(file);return {status:file==='cargo'?1:0};}}),'/local/cargo/bin/cargo');
  assert.deepEqual(calls,['cargo','/local/cargo/bin/cargo']);
});
