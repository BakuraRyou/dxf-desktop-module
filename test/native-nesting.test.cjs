const { test } = require('node:test');
const { Worker } = require('node:worker_threads');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { LocalModules } = require('../../../Animatus-Desktop/src/core/modules.cjs');
const requireEditor = createRequire(require.resolve('../../dxf-editor-v2/package.json'));
requireEditor('tsx/cjs');
const { buildPolyVariants, packDrawableBlocks, validateRealBoundingPlacements } = require('../../dxf-editor-v2/src/frontend/components/dxf-editor-v2/editor/util.ts');
const binary = process.platform === 'win32' ? 'animatus-nesting.exe' : 'animatus-nesting';
function triangle(name) {
  const outline = { closed: true, kind: 'outline', layer: '1', points: [{ x: -50, y: 200 }, { x: 50, y: 200 }, { x: -50, y: 300 }] };
  return { name, pieceLabel: name, paths: [outline], packPaths: [outline], bounds: { minX: -50, minY: 200, maxX: 50, maxY: 300 }, width: 100, height: 100 };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animatus-native-nesting-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modules = new LocalModules({ directory: path.join(root, 'installed') });
  t.after(() => modules.stop());
  const source = path.join(root, 'source');
  fs.cpSync(path.resolve(__dirname, '../dist'), source, { recursive: true });
  modules.install(source); fs.rmSync(source, { recursive: true });
  const input = { blocks: [triangle('a'), triangle('b')], fabricWidth: 150, rotationStep: 180,
    useRealBounding: true, grid: 3, outlineMarginMm: 0, maxRandomOrders: 1,
    vectorGuard: true, reportPreview: true, extreme: { strategy: 'adaptive', timeBudgetMs: 2500 } };
  return { modules, input };
}
test('installed native solver needs no source or training and preserves the best exact layout and final preview', async t => {
  if (!fs.existsSync(path.resolve(__dirname, '../dist', binary))) return t.skip('portable build has no native solver');
  const { modules, input } = fixture(t);
  const stages = [], heights = [], executions = [];
  let preview;
  const result = await modules.run({ module: 'dxf-packing', operation: 'pack-nesting-v2', input }, { onMessage: event => {
    const m = event.data;
    if (m.type === 'search-progress') stages.push(m);
    if (m.type === 'packing-execution') executions.push(m);
    if (m.type === 'attempt') heights.push(m.usedHeight);
    if (m.previewPlacements) preview = m;
  } });
  assert.ok(stages.some(s => s.stage === 'nesting'));
  assert.ok(executions.every(e=>e.location==='desktop'));
  assert.ok(executions.some(e=>e.backend==='native-nesting'));
  const nativeIndex=executions.findIndex(e=>e.backend==='native-nesting');
  assert.ok(executions.slice(nativeIndex+1).some(e=>e.backend==='javascript'));
  assert.equal(result.placements.length, 2);
  assert.ok(result.placements.every(p => [0, 180].includes(p.variant.angle)));
  assert.ok(result.usedHeight <= Math.min(...heights) + .0001);
  assert.equal(validateRealBoundingPlacements(result.placements, 150), true);
  assert.equal(preview.usedHeight, result.usedHeight);
  assert.deepEqual(preview.previewPlacements.map(p => [p.x, p.y, p.angle]), result.placements.map(p => [p.x, p.y, p.variant.angle]));
});
test('cancelling during native optimization reaps its process before releasing the module job', async t => {
  if (!fs.existsSync(path.resolve(__dirname, '../dist', binary))) return t.skip('portable build has no native solver');
  const { modules, input } = fixture(t);
  const directory = modules.modules.get('dxf-packing').directory;
  const pidFile = path.join(directory, 'owned-solver.pid');
  if (process.platform !== 'win32') {
    const executable = path.join(directory, binary), real = executable + '.real';
    fs.renameSync(executable, real);
    const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
    fs.writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$$" >> ' + quote(pidFile) + '\nexec ' + quote(real) + '\n');
    fs.chmodSync(executable, 0o755);
  }
  let ready;
  const running = new Promise(resolve => { ready = resolve; });
  const timer = setTimeout(() => ready(false), 6000);
  let nativeUpdates = 0;
  const task = modules.run({ jobId: 'native-cancel', module: 'dxf-packing', operation: 'pack-nesting-v2',
    input: { ...input, blocks: Array.from({ length: 80 }, (_, i) => triangle(`cancel-${i}`)), fabricWidth: 1400,
      extreme: { strategy: 'adaptive', timeBudgetMs: 30000 } } }, { onMessage: event => {
      if (event.data.stage === 'nesting' && ++nativeUpdates >= 2 && event.data.elapsedMs >= 500) ready(true);
    } });
  const outcome = task.then(value => ({ value }), error => ({ error }));
  assert.equal(await running, true); clearTimeout(timer);
  const pids = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number) : [];
  if (process.platform !== 'win32') { assert.ok(pids.length); for (const pid of pids) { assert.ok(pid > 0); process.kill(pid, 0); } }
  assert.equal(await modules.cancel('native-cancel'), true);
  assert.match((await outcome).error?.message || '', /Berechnung/);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'every owned solver must be gone before cancellation acknowledgement');
  assert.equal(modules.jobs.size, 0);
  const next = await modules.run({ module: 'dxf-packing', operation: 'pack-v2', input: { ...input, extreme: undefined, useRealBounding: false } });
  assert.equal(next.placements.length, 2);
});
test('a broken native executable retains a valid fallback result', async t => {
  const { modules, input } = fixture(t);
  const directory = modules.modules.get('dxf-packing').directory;
  fs.writeFileSync(path.join(directory, binary), 'invalid executable');
  fs.chmodSync(path.join(directory, binary), 0o755);
  const result = await modules.run({ module: 'dxf-packing', operation: 'pack-extreme-v2', input });
  assert.equal(validateRealBoundingPlacements(result.placements, 150), true);
  assert.equal(result.placements.length, 2);
});


test('native searches use distinct seeds and accept a shorter valid warm start', async t => {
  const executable = path.resolve(__dirname, '../dist', binary);
  if (!fs.existsSync(executable)) return t.skip('portable build has no native solver');
  const { createNativeNestingBackend } = require('../src/native-nesting.ts');
  const blocks = [triangle('warm-a'),triangle('warm-b')];
  const items = blocks.map(block=>({block,area:5000,variants:buildPolyVariants(block,180,3)}));
  const seed = packDrawableBlocks(blocks,150,180,{orderTrials:1,outlineMarginMm:.05});
  const placements = items.map((item,i)=> {
    const variant = item.variants.find(v=>v.variant.angle===180*i).variant;
    return {block:item.block,variant,x:.05+i*.05,y:.05+i*.05,width:100,height:100};
  });
  assert.ok(validateRealBoundingPlacements(placements,150));
  const starts = [];
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),3000);
  t.after(()=>clearTimeout(timeout));
  await createNativeNestingBackend(executable,controller.signal)({items,seed,warmSeed:{placements,usedHeight:100.1},fabricWidth:150,timeBudgetMs:600001,workers:2,targetLengthMm:101,stopAtTarget:true,
    onStart:value=>starts.push(value), onCandidate:async()=>false});
  const expected = Math.max(1,Math.min(2,Math.floor(os.availableParallelism()/2)));
  assert.equal(starts.length,expected);
  assert.equal(new Set(starts.map(s=>s.rngSeed)).size,expected);
  assert.ok(starts.every(s=>s.warmStarted));
});

test('an installed module continues a valid layout without increasing fabric length', async t => {
  if (!fs.existsSync(path.resolve(__dirname, '../dist', binary))) return t.skip('portable build has no native solver');
  const { createPackingStartLayout } = require('../../dxf-editor-v2/src/frontend/lib/packing-start-layout.ts');
  const { modules,input } = fixture(t);
  const first = await modules.run({module:'dxf-packing',operation:'pack-nesting-v2',input});
  const initialLayout = createPackingStartLayout(first.placements,input.blocks,input.fabricWidth,180);
  assert.ok(initialLayout);
  const next = await modules.run({module:'dxf-packing',operation:'pack-continue-v2',input:{...input,initialLayout}});
  assert.ok(next.usedHeight <= first.usedHeight + .0001);
  assert.ok(validateRealBoundingPlacements(next.placements,150));
});


test('forcibly terminating an owned worker closes its native solver lifeline', async t => {
  const executable = path.resolve(__dirname,'../dist',binary);
  if (!fs.existsSync(executable)) return t.skip('portable build has no native solver');
  const { createNativeProblem } = require('../src/native-nesting.ts');
  const blocks = Array.from({length:80},(_,i)=>triangle(`lifeline-${i}`));
  const items = blocks.map(block=>({block,area:5000,variants:buildPolyVariants(block,180,3)}));
  const seed = packDrawableBlocks(blocks,1400,180,{orderTrials:1,outlineMarginMm:.05});
  const {request} = createNativeProblem({items,seed,fabricWidth:1400,timeBudgetMs:30000,onCandidate:async()=>false});
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const child=require('node:child_process').spawn(workerData.executable,[],{stdio:['pipe','pipe','pipe']});
    let buffer='';
    child.stdout.on('data',chunk=>{buffer+=chunk; if(buffer.includes('"type":"start"')) parentPort.postMessage(child.pid);});
    child.stdin.on('error',()=>{});
    child.stdin.write(JSON.stringify(workerData.request)+'\\n');
    setInterval(()=>child.stdin.write('\\n'),500);
  `,{eval:true,workerData:{executable,request}});
  t.after(()=>worker.terminate());
  const pid = await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('native solver did not start')),5000);
    worker.once('error',reject);worker.once('message',value=>{clearTimeout(timeout);resolve(value);});
  });
  assert.ok(pid>0); process.kill(pid,0);
  await worker.terminate();
  let gone=false;
  for(let i=0;i<200;i++){
    try {
      process.kill(pid,0);
      // A child owned by a destroyed Node thread may await parent-process
      // reaping on Linux. Z means it has exited and consumes no CPU or memory.
      if (process.platform === 'linux' && fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1]?.startsWith('Z ')) { gone=true; break; }
    } catch(error) { if(error.code==='ESRCH' || error.code==='ENOENT'){gone=true;break;} throw error; }
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.ok(gone,'worker termination must stop its own solver without waiting for the 30-second budget');
});
