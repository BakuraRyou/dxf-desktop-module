const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const policy = require('../src/order-policy.cjs');
const { LocalModules } = require('../../../Animatus-Desktop/src/core/modules.cjs');
function dxf(scale) {
  const pairs = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'BLOCKS'];
  for (let i = 0; i < 3; i++) {
    const width = scale * (i + 2), height = 40 + i * 20;
    pairs.push('0', 'BLOCK', '8', '0', '2', `Piece${i}_40`, '70', '0', '10', '0', '20', '0', '30', '0',
      '0', 'LWPOLYLINE', '8', '1', '90', '4', '70', '1');
    for (const [x, y] of [[0, 0], [width, 0], [width, height], [0, height]]) pairs.push('10', String(x), '20', String(y));
    pairs.push('0', 'ENDBLK');
  }
  pairs.push('0', 'ENDSEC', '0', 'EOF'); return pairs.join('\n');
}
test('folder command trains real DXF geometry, isolates holdout and duplicates, and resumes durable weights', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animatus-neural-training-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'), output = path.join(root, 'output');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'a.dxf'), dxf(30));
  fs.writeFileSync(path.join(data, 'a-copy.dxf'), dxf(30));
  fs.writeFileSync(path.join(data, 'b.DXF'), dxf(50));
  const script = path.resolve(__dirname, '../training/train.mjs');
  const args = [script, `--data=${data}`, `--output=${output}`, '--gap=6', '--samples=2', '--epochs=1', '--compaction-ms=0'];
  await run(process.execPath, args, { timeout: 20000 });
  const read = name => JSON.parse(fs.readFileSync(path.join(output, name), 'utf8'));
  const dataset = read('dataset.json');
  assert.equal(dataset.duplicates, 1);
  assert.equal(dataset.accepted.length, 2);
  assert.deepEqual(dataset.accepted.map(f => f.split).sort(), ['train', 'validation']);
  assert.ok(dataset.accepted.every(f => f.units === 'mm' && f.pieces === 3));
  const model = policy.validateDeployment(read('best-model.json'));
  await run(process.execPath, args.map(arg => arg.startsWith('--data=') ? '--data=./data' : arg.startsWith('--output=') ? '--output=./output' : arg).concat('--resume', '--prepare-only'), {
    env: { ...process.env, INIT_CWD: root }, timeout: 20000,
  });
  assert.equal(model.trainedSteps, 1, 'holdout must never update weights');
  assert.equal(model.config.gap, 6);
  assert.equal(model.config.mirror, false);
  assert.equal(model.config.rotation, 180);
  assert.equal(model.validation.rows.length, 1);
  // Exercise the actual installed V2 module with the newly trained weights.
  const source = path.join(root, 'module-source');
  fs.cpSync(path.resolve(__dirname, '../dist'), source, { recursive: true });
  fs.copyFileSync(path.join(output, 'best-model.json'), path.join(source, 'order-policy.json'));
  const modules = new LocalModules({ directory: path.join(root, 'installed') });
  t.after(() => modules.stop());
  modules.install(source);
  fs.rmSync(source, { recursive: true });
  const { blocks } = read(dataset.accepted[0].prepared);
  const packed = await modules.run({ module: 'dxf-packing', operation: 'pack-extreme-v2', input: {
    blocks, fabricWidth: 1400, rotationStep: 180, useRealBounding: true, grid: 5,
    outlineMarginMm: 0, vectorGuard: true, maxRandomOrders: 1, reportProgress: false,
    extreme: { timeBudgetMs: 1000, maxAttempts: 5, strategy: 'adaptive' },
  } });
  assert.equal(packed.type, 'done');
  assert.equal(packed.placements.length, 3);
  assert.ok(packed.placements.every(p => [0, 180].includes(p.variant.angle)));
  // A malformed installed checkpoint must fail, proving the model was actually read.
  fs.writeFileSync(path.join(modules.modules.get('dxf-packing').directory, 'order-policy.json'), '{}');
  await assert.rejects(modules.run({ module: 'dxf-packing', operation: 'pack-extreme-v2', input: {
    blocks, fabricWidth: 1400, rotationStep: 180, useRealBounding: true,
    extreme: { timeBudgetMs: 1000, maxAttempts: 1, strategy: 'adaptive' },
  } }));
  await assert.rejects(run(process.execPath, args), /--resume/);
  await run(process.execPath, args.map(arg => arg === '--epochs=1' ? '--epochs=2' : arg).concat('--resume'), { timeout: 20000 });
  assert.equal(read('latest.json').model.trainedSteps, 2);
  assert.equal(read('report.json').history.length, 2);
  await assert.rejects(run(process.execPath, args.map(arg => arg === '--gap=6' ? '--gap=7' : arg).concat('--resume')), /geändert/);
  assert.ok(!fs.existsSync(path.join(output, '.training.lock')));
});
