import { bundleModels } from './model-bundle.mjs';
import { buildNesting } from './build-nesting.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, chmodSync, cpSync, existsSync, mkdtempSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(root, '../dxf-editor-v2/package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const args = process.argv.slice(2);
if (args.some(arg => !['--native', '--with-models', '--portable'].includes(arg) && !arg.startsWith('--models=') && !arg.startsWith('--order-model='))) throw new Error('Unterstützte Optionen: --native, --portable, --with-models, --models=<Ordner>, --order-model=<Checkpoint>');
if (args.filter(arg => arg.startsWith('--models=')).length > 1) throw new Error('Gib genau einen Modellordner an.');
if (args.filter(arg => arg.startsWith('--order-model=')).length > 1) throw new Error('Gib genau einen Reihenfolge-Checkpoint an.');
const orderModelFile = args.find(arg => arg.startsWith('--order-model='))?.slice('--order-model='.length);
const policy = createRequire(import.meta.url)('../src/order-policy.cjs');
const orderModel = orderModelFile ? policy.validateDeployment(JSON.parse(readFileSync(path.resolve(orderModelFile), 'utf8'))) : null;
const native = args.includes('--native');
const release = path.join(root, 'dist');
const models = path.resolve(args.find(arg => arg.startsWith('--models='))?.slice('--models='.length) || path.join(root, 'models'));
if (models === release || models.startsWith(release + path.sep)) throw new Error('Der Modellquellordner muss außerhalb von dist liegen.');
mkdirSync(path.join(root, '.temp'), { recursive: true });
const output = mkdtempSync(path.join(root, '.temp/module-build-'));
try {
const modelBundle = await bundleModels({ source: models, output, required: args.includes('--with-models') || args.some(arg => arg.startsWith('--models=')) });
const nesting = args.includes('--portable') ? null : buildNesting(output);
if (orderModel) writeFileSync(path.join(output, 'order-policy.json'), JSON.stringify(orderModel) + '\n');
for (const version of ['v2', 'v3']) {
  await build({ configFile: false, root: path.join(root, `../dxf-editor-${version}`), publicDir: false, envDir: false,
    ssr: { noExternal: true }, build: { target: 'node22', outDir: output, emptyOutDir: false,
      ssr: path.join(root, `src/${version}.ts`), minify: false,
      rollupOptions: { output: { format: 'es', entryFileNames: `engine-${version}.mjs` } } } });
}
if (native) {
  // Build only the host platform's binary. End users need neither Cargo nor Node.
  execFileSync(process.execPath, [path.join(root, '../dxf-editor-v2/scripts/build-rust-packer.mjs'), '--native-only'], { stdio: 'inherit' });
  const name = process.platform === 'win32' ? 'dxf-raster-packer.exe' : 'dxf-raster-packer';
  copyFileSync(path.join(root, '../dxf-editor-v2/electron/dist', name), path.join(output, name));
  chmodSync(path.join(output, name), 0o755);
}
writeFileSync(path.join(output, 'worker.cjs'), `const { workerData } = require('node:worker_threads');
const version = workerData.operation === 'models-status-v2' ? 'v2' : /^(pack(?:-(?:extreme|hybrid|target|nesting|continue|configured))?|poly)-(v2|v3)$/.exec(workerData.operation)?.[2];
if (!version) throw new Error('Unbekannte DXF-Berechnung');
import('./engine-' + version + '.mjs').catch(error => { throw error; });
`);
writeFileSync(path.join(output, 'animatus-module.json'), JSON.stringify({
  apiVersion: 1, id: 'dxf-packing', name: 'DXF-Berechnung', version: '1.7.1', entry: 'worker.cjs',
  operations: ['models-status-v2', 'pack-hybrid-v2', 'pack-target-v2', 'pack-configured-v2', 'pack-v2', 'pack-extreme-v2', 'poly-v2', 'pack-v3', 'poly-v3', ...(nesting ? ['pack-nesting-v2', 'pack-continue-v2'] : [])],
  ...((native || nesting || modelBundle.platform || modelBundle.architecture) ? { platforms: [process.platform], architectures: [process.arch] } : {}),
  ...(nesting ? { nesting } : {}),
  ...(modelBundle.included ? { models: modelBundle.models, selfContainedModels: true } : {}),
  ...(orderModel ? { orderPolicy: { kind: orderModel.kind, trainedSteps: orderModel.trainedSteps, experimental: true } } : {})
}, null, 2) + '\n');
if (!modelBundle.included && existsSync(models)) cpSync(models, path.join(output, 'models'), { recursive: true });
// Publish only after model inspection and engine compilation have succeeded.
const backup = release + '.previous-' + Date.now();
if (existsSync(release)) renameSync(release, backup);
try { renameSync(output, release); }
catch (error) { if (existsSync(backup)) renameSync(backup, release); throw error; }
if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
console.log(`DXF-Modul: ${release} (${native ? 'Rust nativ' : 'Rust/WASM im Node-Worker'}; ${modelBundle.included ? 'Nester-/RL4CO-Paket mitgeliefert' : orderModel ? 'Animatus-Reihenfolgemodell mitgeliefert' : 'ohne neuronale Modellartefakte'})`);
if (orderModel) console.log('Experimentelles Animatus-Reihenfolgemodell mitgeliefert; nur adaptive Extreme-Suche in V2.');
if (nesting) console.log('Sparrow-Nesting für V2 mitgeliefert; keine Modellinstallation erforderlich.');
} catch (error) {
  rmSync(output, { recursive: true, force: true });
  throw error;
}
