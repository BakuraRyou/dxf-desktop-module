const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const providers = require('../src/model-providers.cjs');

// Protocol fixtures only. No trained model is generated or shipped by these tests.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dxf-model-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), output = path.join(root, 'output');
  fs.mkdirSync(path.join(source, 'runtime'), { recursive: true });
  fs.mkdirSync(output);
  fs.copyFileSync(process.execPath, path.join(source, 'runtime', 'fixture-node'));
  fs.chmodSync(path.join(source, 'runtime', 'fixture-node'), 0o755);
  fs.writeFileSync(path.join(source, 'fixture.checkpoint'), 'not-a-neural-model');
  fs.writeFileSync(path.join(source, 'predict.cjs'), `
const fs=require('node:fs');let text='';process.stdin.on('data',d=>text+=d);
process.stdin.on('end',()=>{const r=JSON.parse(text);fs.readFileSync(r.checkpoint);
process.stdout.write(JSON.stringify({schemaVersion:1,model:r.model,trained:true,ready:true}));});`);
  const config = { schemaVersion: 1, platform: process.platform, architecture: process.arch,
    models: ['nester', 'rl4co'].map(id => ({ id, runtime: 'bundled', executable: 'runtime/fixture-node',
      entry: 'predict.cjs', checkpoint: 'fixture.checkpoint', maxPieces: 105,
      task: 'fixed-width-strip-v1', supportsRotationRestrictions: true })) };
  const save = () => fs.writeFileSync(path.join(source, 'models.json'), JSON.stringify(config));
  save(); return { root, source, output, config, save };
}

test('model bundle supplies checkpoints and its executable without host Python or the source directory', async t => {
  const { bundleModels } = await import('../scripts/model-bundle.mjs');
  const f = fixture(t);
  const previous = process.env.ANIMATUS_DXF_PYTHON;
  process.env.ANIMATUS_DXF_PYTHON = path.join(f.root, 'missing-host-python');
  t.after(() => { if (previous === undefined) delete process.env.ANIMATUS_DXF_PYTHON; else process.env.ANIMATUS_DXF_PYTHON = previous; });
  const bundle = await bundleModels({ ...f, required: true });
  assert.equal(bundle.included, true);
  assert.equal(bundle.platform, process.platform);
  assert.equal(bundle.models.length, 2);
  fs.rmSync(f.source, { recursive: true });
  assert.equal((await providers.inspectModels(f.output)).ready, true);
});

test('a distributable model bundle rejects a host Python requirement and a different native platform', async t => {
  const { bundleModels } = await import('../scripts/model-bundle.mjs');
  const f = fixture(t);
  f.config.models[0].runtime = 'python'; f.save();
  await assert.rejects(bundleModels({ ...f, required: true }), /installiertes Python/);
  f.config.models[0].runtime = 'bundled'; f.config.platform = 'another-platform'; f.save();
  await assert.rejects(bundleModels({ ...f, required: true }), /Betriebssystem/);
});

test('a strict model build fails without artifacts and preserves the previous complete module', t => {
  const root = path.resolve(__dirname, '..');
  const filename = path.join(root, 'dist/animatus-module.json');
  const before = fs.readFileSync(filename, 'utf8');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs'), '--with-models',
    '--models=' + path.join(root, '.temp/nonexistent-model-artifacts')], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /echte Gewichte/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
});
