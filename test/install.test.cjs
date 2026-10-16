const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalModules } = require('../sdk/modules.cjs');
const { ModuleInstallation } = require('../sdk/module-installation.cjs');
const { packageModule } = require('../sdk/package-module.cjs');
const { resolveModule } = require('../sdk/module-catalog.cjs');

function rectangle(name, width = 102, height = 102) {
  const outline = { closed: true, kind: 'outline', layer: '14', points: [
    { x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }
  ] };
  return { name, pieceLabel: name, polyType: 0, groupId: null, paths: [outline], packPaths: [outline],
    bounds: { minX: 0, minY: 0, maxX: width, maxY: height }, width, height };
}
const input = () => ({ blocks: [rectangle('a'), rectangle('b')], fabricWidth: 204, rotationStep: null,
  outlineMarginMm: 0, grid: 3, vectorGuard: true, compactionPasses: 2,
  useRealBounding: true, maxRandomOrders: 1, reportPreview: true });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animatus-dxf-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = path.join(root, 'release');
  const descriptor = packageModule(path.resolve(__dirname, '../dist'), 'https://local-fixture.invalid/dxf/', release);
  const modules = new LocalModules({ directory: path.join(root, 'installed') });
  t.after(() => modules.stop());
  return { root, release, descriptor, modules };
}

test('real DXF package installs live through catalog, checksums and installer, without marketplace or listener', async t => {
  const f = fixture(t);
  // This registry already exists before installation, just as in the running app.
  assert.deepEqual(f.modules.list(), []);
  let prompts = 0;
  const states = [];
  const installation = new ModuleInstallation({ modules: f.modules,
    resolve: request => resolveModule(request, { bundled: [f.descriptor] }),
    confirm: async () => { prompts++; return true; }, onProgress: event => states.push(event.state),
    fetch: async url => {
      const file = f.descriptor.files.find(file => file.url === url);
      assert.ok(file, 'only packaged URLs may be downloaded');
      return new Response(fs.readFileSync(path.join(f.release, 'files', file.path)));
    }
  });
  const request = { module: 'dxf-packing', operation: 'pack-v2' };
  assert.equal((await installation.ensure(request, { scope: 'test' })).available, true);
  assert.ok(states.includes('installing'));
  assert.equal(states.at(-1), 'installed');
  // Installation must be self-contained: remove every source used by the installer.
  fs.rmSync(f.release, { recursive: true });
  for (const version of ['v2', 'v3']) {
    const messages = [];
    const result = await f.modules.run({ module: 'dxf-packing', operation: `pack-${version}`, input: input() },
      { onMessage: message => messages.push(message.data) });
    assert.equal(result.type, 'done');
    assert.equal(result.placements.length, 2);
    assert.ok(Math.abs(result.usedHeight - 102) < 0.01);
    assert.ok(messages.some(message => message.type === 'progress'));
    assert.ok(messages.some(message => message.type === 'attempt'));
    const rectangular = await f.modules.run({ module: 'dxf-packing', operation: `pack-${version}`,
      input: { ...input(), useRealBounding: false, maxRandomOrders: 0, rotationStep: 0 } });
    assert.equal(rectangular.placements.length, 2);
    let jobId;
    const poly = await f.modules.run({ module: 'dxf-packing', operation: `poly-${version}`, input: input() }, {
      onProgress: event => { jobId = event.jobId; },
      onMessage: event => {
        if (event.data.type !== 'resolve-order-unit') return;
        assert.equal(f.modules.message(jobId, { orderRequestId: event.data.orderRequestId, unit: '0' }, 'another-tab'), false);
        assert.equal(f.modules.message(jobId, { orderRequestId: event.data.orderRequestId, unit: '0' }), true);
      }
    });
    assert.equal(poly.packed.placements.length, 2);
    assert.ok(['rust-native', 'rust-wasm'].includes(poly.backend.backend));
  }
  await installation.ensure(request, { scope: 'test' });
  assert.equal(prompts, 1);
  const reopened = new LocalModules({ directory: f.modules.directory });
  t.after(() => reopened.stop());
  assert.equal(reopened.list()[0].id, 'dxf-packing');
});

test('folder installation and removal of sources work without restarting the registry', async t => {
  const f = fixture(t);
  f.modules.install(path.join(f.release, 'files'));
  fs.rmSync(f.release, { recursive: true });
  const result = await f.modules.run({ module: 'dxf-packing', operation: 'pack-v3', input: input() });
  assert.equal(result.placements.length, 2);
});

test('tab ownership and cancellation release a waiting distributed search', async t => {
  const f = fixture(t);
  f.modules.install(path.resolve(__dirname, '../dist'));
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  const jobId = 'cancel-dxf-test';
  const task = f.modules.run({ jobId, module: 'dxf-packing', operation: 'poly-v2', input: input() }, {
    owner: 'tab-a', onMessage: event => { if (event.data.type === 'resolve-order-unit') ready(); }
  });
  const rejected = assert.rejects(task, /Berechnung/);
  await waiting;
  assert.equal(await f.modules.cancel(jobId, 'tab-b'), false);
  assert.equal(await f.modules.cancel(jobId, 'tab-a'), true);
  await rejected;
  assert.equal(f.modules.jobs.size, 0);
});

test('intentional module cancellation reaches the Desktop IPC adapter as a normal stopped result', async t => {
  const { moduleRunResult } = require('../sdk/module-run-result.cjs');
  const f = fixture(t);
  f.modules.install(path.resolve(__dirname, '../dist'));
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  const task = moduleRunResult(f.modules.run({ jobId: 'ipc-cancel', module: 'dxf-packing', operation: 'poly-v2', input: input() }, {
    owner: 'ipc-tab', onMessage: event => { if (event.data.type === 'resolve-order-unit') ready(); },
  }));
  await waiting;
  await f.modules.cancel('ipc-cancel', 'ipc-tab', 'navigation');
  assert.deepEqual(await task, { type: 'stopped' });
  assert.equal(f.modules.jobs.size, 0);
});

test('invalid geometry fails in the worker and frees its execution slot', async t => {
  const f = fixture(t);
  f.modules.install(path.resolve(__dirname, '../dist'));
  await assert.rejects(f.modules.run({ module: 'dxf-packing', operation: 'pack-v2', input: { ...input(), fabricWidth: -1 } }), /Berechnung/);
  assert.equal(f.modules.jobs.size, 0);
});

test('updated editor reaches the installed module through the streaming bridge', async t => {
  const f = fixture(t);
  const { createRequire } = require('node:module');
  const requireEditor = createRequire(require.resolve('../package.json'));
  requireEditor('tsx/cjs');
  const { createDesktopPackingWorker } = require('../client.ts');
  const installation = new ModuleInstallation({ modules: f.modules, catalog: [f.descriptor],
    confirm: async () => true,
    fetch: async url => {
      const file = f.descriptor.files.find(file => file.url === url);
      return new Response(fs.readFileSync(path.join(f.release, 'files', file.path)));
    }
  });
  const previous = globalThis.animatusDesktop;
  t.after(() => { globalThis.animatusDesktop = previous; });
  const listeners = new Set();
  globalThis.animatusDesktop = { modules: { streaming: 1,
    ensure: request => installation.ensure(request, { scope: 'test' }),
    run: request => f.modules.run(request, { owner: 'editor-tab',
      onMessage: event => { for (const listener of listeners) listener(event); } }),
    onMessage: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    message: ({ jobId, data }) => Promise.resolve(f.modules.message(jobId, data, 'editor-tab')),
    cancel: jobId => f.modules.cancel(jobId, 'editor-tab')
  } };
  const worker = createDesktopPackingWorker('v3', () => { throw new Error('unexpected browser computation'); });
  t.after(() => worker.terminate());
  const result = await new Promise((resolve, reject) => {
    worker.onmessage = event => {
      if (event.data.type === 'done') resolve(event.data);
      else if (event.data.type === 'error') reject(new Error(event.data.message));
    };
    worker.postMessage({ type: 'pack', payload: input() });
  });
  assert.equal(result.placements.length, 2);
  assert.equal(listeners.size, 0);
  assert.equal(f.modules.jobs.size, 0);
});

test('folder install rejects native packages for a different platform', t => {
  const f = fixture(t);
  const source = path.join(f.release, 'files');
  const filename = path.join(source, 'animatus-module.json');
  const manifest = JSON.parse(fs.readFileSync(filename));
  manifest.platforms = ['another-platform'];
  fs.writeFileSync(filename, JSON.stringify(manifest));
  assert.throws(() => f.modules.install(source), /Betriebssystem/);
  assert.deepEqual(f.modules.list(), []);
});


test('V2 real bounding returns a valid result when compaction rounds a fractional fabric boundary', async t => {
  const f = fixture(t);
  f.modules.install(path.resolve(__dirname, '../dist'));
  const blocks = [rectangle('fixed', 104, 100), rectangle('moving', 100.0004, 100)];
  for (const fabricWidth of [204, 204.0004]) {
    const result = await f.modules.run({ module: 'dxf-packing', operation: 'pack-v2', input: {
      ...input(), blocks, fabricWidth
    } });
    assert.equal(result.type, 'done');
    assert.equal(result.placements.length, 2);
    for (const p of result.placements) assert.ok(p.x + p.width <= fabricWidth + 0.0001);
    const { createRequire } = require('node:module');
    const requireEditor = createRequire(require.resolve('../package.json'));
    requireEditor('tsx/cjs');
    const { validateRealBoundingPlacements } = require('../vendor/dxf-editor-v2/src/frontend/components/dxf-editor-v2/editor/util.ts');
    assert.equal(validateRealBoundingPlacements(result.placements, fabricWidth), true);
    if (fabricWidth > 204) assert.ok(Math.abs(result.usedHeight - 100) < 0.01);
  }
});


test('V2 finishes after the complete preview for 105 real DXF contours', async t => {
  const f = fixture(t);
  f.modules.install(path.resolve(__dirname, '../dist'));
  const { createRequire } = require('node:module');
  const requireEditor = createRequire(require.resolve('../package.json'));
  requireEditor('tsx/cjs');
  const util = require('../vendor/dxf-editor-v2/src/frontend/components/dxf-editor-v2/editor/util.ts');
  const source = await util.parseDxfTextInBrowser(fs.readFileSync(
    path.resolve(__dirname, 'fixtures/correct_NoliLS326_40-52.dxf'), 'utf8'));
  const nameMap = util.deriveBlockNameMap(source.blocks);
  const base = util.detectHelperBaseSizeFromMarkers(source.blocks, nameMap);
  const all = util.buildDrawableBlocks(source.blocks, null, {
    nameMap, helperBaseSizeLabel: base, forceHelperBasePropagation: true,
  });
  const selected = all.filter(block => nameMap.get(block.name)?.sizeLabel?.toLowerCase() === base?.toLowerCase());
  const prepared = util.prepareBlocksForWorker(selected.length ? selected : all, true, 0).blocks;
  assert.ok(prepared.length > 0);
  // Scale the fixture to keep raster search small; exact contour complexity
  // and the number of pieces/candidate contacts remain unchanged.
  const scalePaths = paths => paths.map(contour => ({ ...contour,
    points: contour.points.map(point => ({ x: point.x / 4, y: point.y / 4 })),
  }));
  const blocks = Array.from({ length: 105 }, (_, index) => {
    const block = prepared[index % prepared.length];
    return { ...block, name: `piece-${index}`, width: block.width / 4, height: block.height / 4,
      bounds: Object.fromEntries(Object.entries(block.bounds).map(([key, value]) => [key, value / 4])),
      paths: scalePaths(block.paths), packPaths: scalePaths(block.packPaths),
    };
  });
  let completePreviewAt;
  let finalPreview;
  let compacting = false;
  const result = await f.modules.run({ module: 'dxf-packing', operation: 'pack-v2', input: {
    ...input(), blocks, fabricWidth: 350, rotationStep: 180, reportProgress: false,
  } }, { onMessage: event => {
    const message = event.data;
    if (message.type === 'progress' && message.placed === 105) completePreviewAt ??= performance.now();
    if (message.phase === 'compacting') compacting = true;
    if (message.previewPlacements) finalPreview = message;
  } });
  assert.equal(result.type, 'done');
  assert.equal(result.placements.length, 105);
  assert.equal(compacting, true, 'phase must reach the renderer even when only previews are requested');
  assert.ok(completePreviewAt !== undefined);
  const finalizationMs = performance.now() - completePreviewAt;
  assert.ok(finalizationMs < 8000, `completion took ${finalizationMs} ms after the complete preview`);
  assert.equal(util.validateRealBoundingPlacements(result.placements, 350), true);
  assert.equal(finalPreview.usedHeight, result.usedHeight);
  assert.equal(finalPreview.previewPlacements.length, result.placements.length);
  result.placements.forEach((placement, index) => {
    const preview = finalPreview.previewPlacements[index];
    assert.equal(preview.x, placement.x);
    assert.equal(preview.y, placement.y);
    assert.equal(preview.angle, placement.variant.angle);
    assert.equal(preview.anchorMinX, (placement.variant.renderBounds ?? placement.variant.bounds).minX);
    assert.equal(preview.anchorMinY, (placement.variant.renderBounds ?? placement.variant.bounds).minY);
  });
  assert.equal(f.modules.jobs.size, 0);
  t.diagnostic(`105 real DXF pieces finalized ${Math.round(finalizationMs)} ms after the complete preview`);
});


test('Extreme V2 searches through the installed module and returns its shortest valid layout', async t => {
  const f = fixture(t);
  f.modules.install(path.resolve(__dirname, '../dist'));
  const blocks = [[48, 105], [35, 58], [58, 70], [59, 85], [37, 96], [66, 29], [110, 66]]
    .map(([width, height], index) => rectangle(`extreme-${index}`, width, height));
  const candidates = [], progress = [];
  let preview;
  const result = await f.modules.run({ module: 'dxf-packing', operation: 'pack-extreme-v2', input: {
    ...input(), blocks, fabricWidth: 180, rotationStep: 180,
    extreme: { timeBudgetMs: 2000, maxAttempts: 5 },
  } }, { onMessage: event => {
    const message = event.data;
    if (message.type === 'attempt') candidates.push(message);
    if (message.type === 'search-progress') progress.push(message);
    if (message.previewPlacements) preview = message;
  } });
  assert.equal(result.type, 'done');
  assert.equal(result.placements.length, blocks.length);
  assert.ok(candidates.length > 2);
  assert.ok(result.usedHeight <= Math.min(...candidates.map(candidate => candidate.usedHeight)) + 0.0001);
  assert.equal(preview.usedHeight, result.usedHeight);
  assert.ok(progress.at(-1).attempts > 1);
  assert.equal(progress.at(-1).bestHeight, result.usedHeight);
  const { createRequire } = require('node:module');
  const requireEditor = createRequire(require.resolve('../package.json'));
  requireEditor('tsx/cjs');
  const { validateRealBoundingPlacements } = require('../vendor/dxf-editor-v2/src/frontend/components/dxf-editor-v2/editor/util.ts');
  assert.equal(validateRealBoundingPlacements(result.placements, 180), true);
  assert.equal(f.modules.jobs.size, 0);
});

test('Extreme cancellation releases the worker after delivering a complete checkpoint', async t => {
  const f = fixture(t);
  f.modules.install(path.resolve(__dirname, '../dist'));
  let ready;
  const checkpoint = new Promise(resolve => { ready = resolve; });
  const jobId = 'extreme-stop';
  const task = f.modules.run({ jobId, module: 'dxf-packing', operation: 'pack-extreme-v2', input: {
    ...input(), blocks: Array.from({ length: 12 }, (_, index) => rectangle(`p-${index}`, 40 + index, 50 + index)),
    fabricWidth: 200, extreme: { timeBudgetMs: 30000 },
  } }, { owner: 'extreme-tab', onMessage: event => {
    if (event.data.type === 'attempt') ready(event.data);
  } });
  const rejected = assert.rejects(task, /Berechnung/);
  assert.ok((await checkpoint).placements.length === 12);
  assert.equal(await f.modules.cancel(jobId, 'extreme-tab'), true);
  await rejected;
  assert.equal(f.modules.jobs.size, 0);
});

test('Extreme rejects invalid time budgets before starting the search', async t => {
  const f = fixture(t);
  f.modules.install(path.resolve(__dirname, '../dist'));
  await assert.rejects(f.modules.run({ module: 'dxf-packing', operation: 'pack-extreme-v2', input: {
    ...input(), extreme: { timeBudgetMs: 86400001 },
  } }), /Berechnung/);
  assert.equal(f.modules.jobs.size, 0);
});

// These providers are protocol fixtures, deliberately not neural networks.
function installModelFixtures(f, { invalidRotation = false, maxPieces = 20 } = {}) {
  const source = path.join(f.release, 'files');
  const directory = path.join(source, 'models');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'fixture.checkpoint'), 'protocol-fixture-not-a-trained-model');
  fs.writeFileSync(path.join(directory, 'predict.cjs'), `
const fs = require('node:fs'); const path = require('node:path');
let text = ''; process.stdin.on('data', data => text += data);
process.stdin.on('end', () => {
 const request = JSON.parse(text);
 fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({model:request.model,action:request.action})+'\\n');
 const response = {schemaVersion:1, model:request.model, trained:true};
 if (request.action === 'status') response.ready = true;
 else if(request.model === 'rl4co') response.orders = [request.input.blocks.map((_, index) => index).reverse()];
 else { let x = 0; response.layouts = [request.input.blocks.map((block, blockIndex) => {
  const placement = {blockIndex, x, y:0, angle:${invalidRotation ? 90 : 0}}; x += block.width; return placement;
 })]; }
 process.stdout.write(JSON.stringify(response));
});`);
  fs.writeFileSync(path.join(directory, 'models.json'), JSON.stringify({ schemaVersion: 1, models: ['nester', 'rl4co'].map(id => ({
    id, runtime: 'node', entry: 'predict.cjs', checkpoint: 'fixture.checkpoint', maxPieces,
    task: 'fixed-width-strip-v1', supportsRotationRestrictions: true,
  })) }));
  return f.modules.install(source);
}

test('unconfigured hybrid reports missing models and never silently runs a heuristic', async t => {
  const f = fixture(t);
  f.modules.install(path.resolve(__dirname, '../dist'));
  const status = await f.modules.run({ module:'dxf-packing', operation:'models-status-v2', input:{} });
  assert.equal(status.ready, false);
  assert.deepEqual(status.models.map(model => model.id), ['nester', 'rl4co']);
  await assert.rejects(f.modules.run({ module:'dxf-packing', operation:'pack-hybrid-v2', input:{
    ...input(), extreme:{timeBudgetMs:1000, strategy:'hybrid'},
  } }), /Berechnung/);
  assert.equal(f.modules.jobs.size, 0);
});

test('hybrid calls both provider fixtures and geometrically validates their combined candidates', async t => {
  const f = fixture(t);
  const installed = installModelFixtures(f);
  const status = await f.modules.run({ module:'dxf-packing', operation:'models-status-v2', input:{} });
  assert.equal(status.ready, true);
  const result = await f.modules.run({ module:'dxf-packing', operation:'pack-hybrid-v2', input:{
    ...input(), blocks:[rectangle('a',100,40), rectangle('b',100,40)], fabricWidth:200,
    rotationStep:180, targetLengthMm:41, stopAtTarget:true,
    extreme:{timeBudgetMs:1000, maxAttempts:2, strategy:'hybrid'},
  } });
  assert.equal(result.type, 'done');
  assert.equal(result.usedHeight, 40);
  assert.equal(result.placements.length, 2);
  const calls = fs.readFileSync(path.join(f.modules.modules.get('dxf-packing').directory, 'models', 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.some(call => call.model === 'nester' && call.action === 'predict'));
  assert.ok(calls.some(call => call.model === 'rl4co' && call.action === 'predict'));
});

test('hybrid rejects provider rotations outside the permitted angles', async t => {
  const f = fixture(t); installModelFixtures(f, { invalidRotation: true });
  await assert.rejects(f.modules.run({ module:'dxf-packing', operation:'pack-hybrid-v2', input:{
    ...input(), blocks:[rectangle('a',100,40)], fabricWidth:200, rotationStep:180,
    extreme:{timeBudgetMs:1000, strategy:'hybrid'},
  } }), /Berechnung/);
});

test('target length remains a goal, retaining a valid layout when it is impossible', async t => {
  const f = fixture(t); f.modules.install(path.resolve(__dirname, '../dist'));
  const result = await f.modules.run({ module:'dxf-packing', operation:'pack-target-v2', input:{
    ...input(), targetLengthMm:10, stopAtTarget:true,
  } });
  assert.equal(result.type, 'done');
  assert.equal(result.placements.length, 2);
  assert.ok(result.usedHeight > 10);
});

test('cancelling hybrid inference terminates its own provider process', async t => {
  const f = fixture(t); installModelFixtures(f);
  const modelRoot = path.join(f.modules.modules.get('dxf-packing').directory, 'models');
  fs.writeFileSync(path.join(modelRoot, 'predict.cjs'), `
const fs=require('node:fs'),path=require('node:path');let input='';
process.stdin.on('data',data=>input+=data);process.stdin.on('end',()=>{
 fs.writeFileSync(path.join(__dirname,'predict.pid'),String(process.pid));
 setInterval(()=>{},1000);
});`);
  const task = f.modules.run({jobId:'hybrid-cancel',module:'dxf-packing',operation:'pack-hybrid-v2',input:{
    ...input(),extreme:{strategy:'hybrid',timeBudgetMs:30000},
  }},{owner:'test-tab'});
  const rejected = assert.rejects(task,/Berechnung/);
  const pidFile = path.join(modelRoot,'predict.pid');
  const deadline = Date.now()+3000;
  while(!fs.existsSync(pidFile) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(fs.existsSync(pidFile),'provider must start');
  const pid=Number(fs.readFileSync(pidFile,'utf8'));
  assert.equal(await f.modules.cancel('hybrid-cancel','test-tab'),true);
  await rejected;
  let alive=true;
  for(let i=0;i<100;i++){
    try { process.kill(pid,0); } catch { alive=false; break; }
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(alive,false,'provider must not outlive the cancelled job');
  assert.equal(f.modules.jobs.size,0);
});


test('free search durations longer than five minutes execute through the configured capability', async t => {
  const f = fixture(t);
  f.modules.install(path.resolve(__dirname,'../dist'));
  const result = await f.modules.run({module:'dxf-packing',operation:'pack-configured-v2',input:{
    ...input(),useRealBounding:true,extreme:{strategy:'adaptive',timeBudgetMs:3600000,maxAttempts:1}
  }});
  assert.equal(result.type,'done');
  assert.equal(result.placements.length,input().blocks.length);
});
