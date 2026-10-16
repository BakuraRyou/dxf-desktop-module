const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const requireEditor = createRequire(require.resolve('../../dxf-editor-v2/package.json'));
requireEditor('tsx/cjs');
const { createDesktopPackingWorker, runDesktopPacking, installedDesktopPacking, observeDesktopPacking } = require('../client.ts');
function bridge(t, available = true) {
  const previous = globalThis.animatusDesktop;
  const listeners = new Set();
  const calls = [];
  globalThis.animatusDesktop = { modules: { streaming: 1,
    ensure: async () => ({ available }),
    run: async request => { calls.push(request); return { type: 'done', placements: [], usedHeight: 1 }; },
    cancel: async () => true,
    message: async () => true,
    onMessage: listener => { listeners.add(listener); return () => listeners.delete(listener); }
  } };
  t.after(() => { globalThis.animatusDesktop = previous; });
  return { modules: globalThis.animatusDesktop.modules, calls, listeners };
}
const message = worker => new Promise(resolve => {
  const listener = event => { if (event.data.type === 'packing-execution') return; worker.removeEventListener('message',listener); resolve(event.data); };
  worker.addEventListener('message',listener);
});

test('host cancellation is delivered as stopped without starting the browser fallback', async t => {
  const f = bridge(t);
  f.modules.run = async () => ({ type: 'stopped' });
  const worker = createDesktopPackingWorker('v2', () => { throw new Error('unexpected fallback'); });
  t.after(() => worker.terminate());
  const result = message(worker);
  worker.postMessage({ type: 'pack', payload: {} });
  assert.deepEqual(await result, { type: 'stopped' });
  assert.equal(f.listeners.size, 0);
});

test('editor worker uses the live module with its cached blocks and forwards progress', async t => {
  const f = bridge(t);
  f.modules.run = async request => {
    f.calls.push(request);
    for (const listener of f.listeners) listener({ jobId: request.jobId, data: { type: 'progress', placed: 1 } });
    await new Promise(resolve => setImmediate(resolve));
    return { type: 'done', placements: [], usedHeight: 1 };
  };
  const worker = createDesktopPackingWorker('v3', () => { throw new Error('browser must not start'); });
  const init = message(worker);
  worker.postMessage({ type: 'initBlocks', blocks: ['cached'] });
  assert.equal((await init).type, 'init-ok');
  const received = [];
  worker.onmessage = event => received.push(event.data.type);
  const finished = new Promise(resolve => worker.addEventListener('message', event => { if (event.data.type === 'done') resolve(); }));
  worker.postMessage({ type: 'pack', payload: { useCache: true } });
  await finished;
  assert.deepEqual(received, ['packing-execution', 'progress', 'done']);
  assert.deepEqual(f.calls[0].input.blocks, ['cached']);
  assert.equal(f.calls[0].operation, 'pack-v3');
  assert.equal(f.listeners.size, 0);
  worker.terminate();
});

test('declined installation keeps browser worker functional across cached computations', async t => {
  bridge(t, false);
  const sent = [];
  const browser = { onmessage: null, postMessage: data => sent.push(data), terminate() {} };
  const worker = createDesktopPackingWorker('v2', () => browser);
  worker.postMessage({ type: 'initBlocks', blocks: ['cached'] });
  worker.postMessage({ type: 'pack', payload: { useCache: true } });
  await new Promise(resolve => setImmediate(resolve));
  browser.onmessage({ data: { type: 'done' } });
  worker.postMessage({ type: 'pack', payload: { useCache: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.ok(sent.every(data => data.payload.useCache === false));
  assert.deepEqual(sent[1].payload.blocks, ['cached']);
  worker.terminate();
});

test('runtime failure never repeats computation in the browser', async t => {
  const f = bridge(t);
  f.modules.run = async () => { throw new Error('runtime failure'); };
  const worker = createDesktopPackingWorker('v2', () => { throw new Error('unexpected fallback'); });
  const result = message(worker);
  worker.postMessage({ type: 'pack', payload: {} });
  assert.deepEqual(await result, { type: 'error', message: 'runtime failure' });
  assert.equal(f.listeners.size, 0);
  worker.terminate();
});

test('stopping during installation does not start native or browser work', async t => {
  const f = bridge(t);
  let confirmed;
  f.modules.ensure = () => new Promise(resolve => { confirmed = resolve; });
  const worker = createDesktopPackingWorker('v2', () => { throw new Error('unexpected fallback'); });
  const stopped = message(worker);
  worker.postMessage({ type: 'pack', payload: {} });
  worker.postMessage({ type: 'stop' });
  confirmed({ available: true });
  assert.equal((await stopped).type, 'stopped');
  assert.equal(f.calls.length, 0);
  worker.terminate();
});

test('active abort cancels only its own job and removes listeners', async t => {
  const f = bridge(t);
  const controller = new AbortController();
  let id;
  let rejectRun;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.modules.run = request => { id = request.jobId; started(); return new Promise((_resolve, reject) => { rejectRun = reject; }); };
  f.modules.cancel = async jobId => { assert.equal(jobId, id); rejectRun(new Error('cancelled')); return true; };
  const task = runDesktopPacking('poly-v2', {}, { signal: controller.signal });
  const rejected = assert.rejects(task, /abgebrochen/);
  await ready;
  controller.abort();
  await rejected;
  assert.equal(f.listeners.size, 0);
});


test('an open editor switches to a module installed after an earlier browser computation', async t => {
  const f = bridge(t, false);
  const browser = { onmessage: null, postMessage() {}, terminate() {} };
  let browserStarts = 0;
  const worker = createDesktopPackingWorker('v2', () => { browserStarts++; return browser; });
  worker.postMessage({ type: 'initBlocks', blocks: ['cached'] });
  worker.postMessage({ type: 'pack', payload: { useCache: true } });
  await new Promise(resolve => setImmediate(resolve));
  browser.onmessage({ data: { type: 'done' } });
  f.modules.ensure = async () => ({ available: true });
  const result = message(worker);
  worker.postMessage({ type: 'pack', payload: { useCache: true } });
  assert.equal((await result).type, 'done');
  assert.equal(browserStarts, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].input.blocks, ['cached']);
  worker.terminate();
});


test('Extreme requests its own module capability and forwards the search budget', async t => {
  const f = bridge(t);
  f.modules.ensure = async request => {
    assert.equal(request.operation, 'pack-nesting-v2');
    return { available: true };
  };
  const worker = createDesktopPackingWorker('v2', () => { throw Error('Unexpected browser fallback'); });
  t.after(() => worker.terminate());
  const done = message(worker);
  worker.postMessage({ type: 'pack', payload: { blocks: [], useRealBounding: true,
    extreme: { timeBudgetMs: 120000 } } });
  assert.equal((await done).type, 'done');
  assert.equal(f.calls[0].operation, 'pack-nesting-v2');
  assert.equal(f.calls[0].input.extreme.timeBudgetMs, 120000);
});


test('hybrid cannot silently fall back to a browser heuristic when its capability is missing', async t => {
  bridge(t, false);
  let fallback = false;
  const worker = createDesktopPackingWorker('v2', () => { fallback = true; throw Error('Unexpected fallback'); });
  t.after(() => worker.terminate());
  const result = message(worker);
  worker.postMessage({type:'pack',payload:{blocks:[], useRealBounding:true, extreme:{strategy:'hybrid',timeBudgetMs:30000}}});
  assert.equal((await result).type, 'error');
  assert.equal(fallback, false);
});

test('an extreme search with a length target requires the target-capable module operation', async t => {
  const f = bridge(t);
  const worker = createDesktopPackingWorker('v2', () => { throw Error('Unexpected fallback'); });
  t.after(() => worker.terminate());
  const done = message(worker);
  worker.postMessage({type:'pack',payload:{blocks:[],useRealBounding:true,targetLengthMm:2000,stopAtTarget:true,extreme:{timeBudgetMs:30000}}});
  assert.equal((await done).type,'done');
  assert.equal(f.calls[0].operation,'pack-nesting-v2');
  assert.equal(f.calls[0].input.targetLengthMm,2000);
});

test('model inspection does not prompt installation and rejects incompatible responses', async t => {
  const f = bridge(t);
  let installations = 0;
  f.modules.ensure = async () => { installations++; return {available:true}; };
  const { getBoundingModelsStatus } = require('../client.ts');
  const status = await getBoundingModelsStatus();
  assert.equal(status.ready,false);
  assert.equal(status.reason,'module-update');
  assert.equal(installations,0);
});


test('continuation requests the updated module capability and retains the initial layout', async t => {
  const f = bridge(t);
  const worker = createDesktopPackingWorker('v2', () => { throw Error('Unexpected fallback'); });
  t.after(() => worker.terminate());
  const initialLayout = { signature:'test', placements:[] };
  const done = message(worker);
  worker.postMessage({type:'pack',payload:{blocks:[],useRealBounding:true,initialLayout,extreme:{timeBudgetMs:30000,workers:2}}});
  assert.equal((await done).type,'done');
  assert.equal(f.calls[0].operation,'pack-continue-v2');
  assert.deepEqual(f.calls[0].input.initialLayout,initialLayout);
});


test('long searches require the updated capability and retain strategy, duration and start layout', async t => {
  const f = bridge(t);
  const worker = createDesktopPackingWorker('v2', () => { throw Error('Unexpected fallback'); });
  t.after(() => worker.terminate());
  for (const strategy of ['adaptive','hybrid']) {
    const done = message(worker);
    const initialLayout = strategy === 'adaptive' ? {signature:'test',placements:[]} : undefined;
    worker.postMessage({type:'pack',payload:{blocks:[],useRealBounding:true,initialLayout,extreme:{strategy,timeBudgetMs:3600000}}});
    assert.equal((await done).type,'done');
    const request = f.calls.at(-1);
    assert.equal(request.operation,'pack-configured-v2');
    assert.equal(request.input.extreme.timeBudgetMs,3600000);
    assert.equal(request.input.extreme.strategy,strategy);
    assert.deepEqual(request.input.initialLayout,initialLayout);
  }
});


test('execution location is reported before a slow local calculation responds', async t => {
  const f = bridge(t);
  let finish;
  f.modules.run = () => new Promise(resolve=>{finish=resolve;});
  const worker = createDesktopPackingWorker('v2',()=>{throw Error('unexpected browser');});
  t.after(()=>worker.terminate());
  const started = new Promise(resolve=>worker.addEventListener('message',event=>{if(event.data.type==='packing-execution')resolve(event.data);}));
  worker.postMessage({type:'pack',payload:{blocks:[]}});
  assert.deepEqual(await started,{type:'packing-execution',location:'desktop',backend:'preparing'});
  const done=message(worker); finish({type:'done'}); await done;
});

test('a declined local module reports browser execution before its first placement', async t => {
  bridge(t,false);
  const browser={onmessage:null,postMessage(){},terminate(){}};
  const worker=createDesktopPackingWorker('v2',()=>browser);
  t.after(()=>worker.terminate());
  const started=new Promise(resolve=>worker.addEventListener('message',event=>{if(event.data.type==='packing-execution')resolve(event.data);}));
  worker.postMessage({type:'pack',payload:{blocks:[]}});
  assert.deepEqual(await started,{type:'packing-execution',location:'browser',backend:'preparing'});
});


test('passive desktop discovery checks installation, permissions, enablement and operations without ensure or run', async t => {
  const f=bridge(t);let prompts=0;
  f.modules.ensure=async()=>{prompts++;throw Error('Unexpected installation');};
  f.modules.capabilities=async()=>({available:true});
  f.modules.list=async()=>[{id:'dxf-packing',enabled:true,operations:['pack-v3','pack-v2']}];
  assert.equal(await installedDesktopPacking(),true);
  f.modules.list=async()=>[{id:'dxf-packing',enabled:false,operations:['pack-v3']}];
  assert.equal(await installedDesktopPacking(),false);
  f.modules.list=async()=>[{id:'dxf-packing',enabled:true,operations:['pack-v2']}];
  assert.equal(await installedDesktopPacking(),false);
  assert.equal(await installedDesktopPacking('v2'),true);
  f.modules.capabilities=async()=>({available:false});
  assert.equal(await installedDesktopPacking('v2'),false);
  f.modules.capabilities=async()=>{throw Error('Foreign frame');};
  assert.equal(await installedDesktopPacking(),false);
  assert.equal(prompts,0);assert.equal(f.calls.length,0);
});

test('desktop discovery tracks install, disable and removal notifications and stops on unmount', async t => {
  const f=bridge(t);let installed=false,changed,unsubscribed=false;
  f.modules.list=async()=>installed?[{id:'dxf-packing',operations:['pack-v3']}]:[];
  f.modules.onChanged=listener=>{changed=listener;return()=>{unsubscribed=true;};};
  const states=[];const stop=observeDesktopPacking(value=>states.push(value));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(states,[false]);
  installed=true;changed();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(states,[false,true]);
  installed=false;changed();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(states,[false,true,false]);
  stop();installed=true;changed();await new Promise(resolve=>setImmediate(resolve));assert.equal(unsubscribed,true);assert.deepEqual(states,[false,true,false]);
});

test('ordinary browsers and older bridges do not claim an installed desktop module', async t => {
 const f=bridge(t);assert.equal(await installedDesktopPacking(),false);
 globalThis.animatusDesktop=undefined;assert.equal(await installedDesktopPacking(),false);
});
