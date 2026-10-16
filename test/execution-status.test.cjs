const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const requireEditor=createRequire(require.resolve('../../dxf-editor-v2/package.json'));
requireEditor('tsx/cjs');
const {installPackingRuntime}=require('../../dxf-editor-v2/src/frontend/lib/packing-runtime.ts');
function blocks() {
  const outline={closed:true,kind:'outline',points:[{x:0,y:0},{x:100,y:0},{x:0,y:100}]};
  return ['a','b'].map(name=>({name,paths:[outline],packPaths:[outline],bounds:{minX:0,minY:0,maxX:100,maxY:100},width:100,height:100}));
}
test('browser execution identifies WebAssembly before waiting and reports JavaScript fallback',async()=>{
  const messages=[];
  const scope={postMessage:message=>messages.push(message)};
  installPackingRuntime(scope,async()=>{
    assert.deepEqual(messages.at(-1),{type:'packing-execution',location:'browser',backend:'rust-wasm'});
    return null;
  });
  await scope.onmessage({data:{type:'pack',payload:{blocks:blocks(),fabricWidth:150,rotationStep:180,useRealBounding:true,maxRandomOrders:1}}});
  const states=messages.filter(m=>m.type==='packing-execution');
  assert.deepEqual(states.map(m=>m.backend),['preparing','rust-wasm','javascript']);
  assert.ok(states.every(m=>m.location==='browser'));
  assert.equal(messages.at(-1).type,'done');
});
test('a failed native startup is not labelled as running native nesting',async()=>{
  const messages=[];
  const scope={postMessage:message=>messages.push(message)};
  installPackingRuntime(scope,async()=>null,async()=>{throw Error('test native startup failed');},{location:'desktop',rasterBackend:'rust-native'});
  await scope.onmessage({data:{type:'pack',payload:{blocks:blocks(),fabricWidth:150,rotationStep:180,useRealBounding:true,maxRandomOrders:1,extreme:{timeBudgetMs:1200}}}});
  const states=messages.filter(m=>m.type==='packing-execution');
  assert.ok(states.every(m=>m.location==='desktop'));
  assert.ok(!states.some(m=>m.backend==='native-nesting'));
  assert.ok(states.some(m=>m.backend==='rust-native'));
  assert.equal(messages.at(-1).type,'done');
});
