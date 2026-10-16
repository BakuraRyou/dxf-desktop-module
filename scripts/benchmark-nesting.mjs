import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = fileURLToPath(new URL('..', import.meta.url));
const options = {};
for (const arg of process.argv.slice(2)) {
  const match = arg.match(/^--(data|seconds|output|only|dataset|baseline-module|workers|continue-seconds)=(.+)$/);
  if (!match) throw new Error('Optionen: --data=<DXF-Ordner> --seconds=30 --output=<Bericht.json> --only=<Dateiname> --dataset=<dataset.json> --baseline-module=<Modulordner> --workers=2 --continue-seconds=30');
  options[match[1]] = match[2];
}
const caller = process.env.INIT_CWD || process.cwd();
const seconds = Number(options.seconds || 30);
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) throw new Error('Suchdauer: 1 bis 300 Sekunden');
const workers = Number(options.workers || 2);
const continueSeconds = Number(options['continue-seconds'] || 0);
if (![1,2,3].includes(workers) || !Number.isFinite(continueSeconds) || continueSeconds < 0 || continueSeconds > 300) throw Error('Ungültige Suchparameter');
const requireEditor = createRequire(path.join(root, '../dxf-editor-v2/package.json'));
requireEditor('tsx/cjs');
const { createPackingStartLayout } = requireEditor('./src/frontend/lib/packing-start-layout.ts');
const nativeName = process.platform === 'win32' ? 'animatus-nesting.exe' : 'animatus-nesting';
if (!fs.existsSync(path.join(root, 'dist', nativeName))) throw new Error('Baue zuerst das DXF-Modul mit der nativen Nesting-Engine.');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'animatus-nesting-benchmark-'));
const output = path.resolve(caller, options.output || path.join(root, '.temp/nesting-benchmark.json'));
const rows = [];
try {
  let datasetFile;
  if (options.dataset) datasetFile = path.resolve(caller, options.dataset);
  else {
    const data = path.resolve(caller, options.data || path.join(root, '../../__mock'));
    const prepared = path.join(scratch, 'dataset');
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, 'training/train.mjs'), `--data=${data}`, '--gap=0', `--output=${prepared}`, '--prepare-only'], { timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
    process.stdout.write(stdout); datasetFile = path.join(prepared, 'dataset.json');
  }
  const dataset = JSON.parse(fs.readFileSync(datasetFile, 'utf8'));
  if (dataset.config.width !== 1400 || dataset.config.rotation !== 180 || dataset.config.gap !== 0) throw new Error('Vergleich benötigt 1400 mm, 180° und Abstand 0 mm.');
  const entries = dataset.accepted.filter(e => !options.only || path.basename(e.file).includes(options.only));
  if (!entries.length) throw new Error('Keine passenden Vergleichsaufträge');
  for (const name of ['baseline', 'native']) fs.cpSync(name === 'baseline' && options['baseline-module'] ? path.resolve(caller, options['baseline-module']) : path.join(root, 'dist'), path.join(scratch, name), { recursive: true });
  if (!options['baseline-module']) fs.rmSync(path.join(scratch, 'baseline', nativeName));
  // Keep the comparison independent of any experimental learned priorities.
  for (const name of ['baseline', 'native']) fs.rmSync(path.join(scratch, name, 'order-policy.json'), { force: true });
  const run = async (engine, blocks, initialLayout, budgetSeconds = seconds) => {
    const started = performance.now();
    const input = { blocks, fabricWidth: 1400, rotationStep: 180, useRealBounding: true, grid: 3,
      outlineMarginMm: 0, maxRandomOrders: 1, vectorGuard: true, extreme: { strategy: 'adaptive', timeBudgetMs: budgetSeconds * 1000, workers }, initialLayout, reportProgress: false };
    return new Promise((resolve, reject) => {
      const worker = new Worker(`let seed=42;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};require(${JSON.stringify(path.join(scratch, engine, 'worker.cjs'))});`, { eval: true, workerData: { operation: initialLayout ? 'pack-continue-v2' : 'pack-extreme-v2', input } });
      let solutions = 0; const starts = [];
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Vergleich überschreitet sein Zeitlimit')); }, budgetSeconds * 1000 + 60000);
      worker.on('error', error => { clearTimeout(timeout); worker.terminate(); reject(error); });
      worker.on('message', message => {
        if (message.type === 'event' && message.value?.stage === 'nesting') {
          solutions = Math.max(solutions, message.value.attempts || 0);
          if (message.value.rngSeed !== undefined) starts.push({rngSeed:message.value.rngSeed,warmStarted:message.value.warmStarted});
        }
        if (message.type !== 'result' && message.type !== 'error') return;
        clearTimeout(timeout); worker.terminate();
        if (message.type === 'error') reject(new Error(message.message));
        else resolve({ placements: message.value.placements, lengthMm: message.value.usedHeight, elapsedMs: performance.now() - started, acceptedNativeSolutions: solutions, starts });
      });
    });
  };
  for (const entry of entries) {
    const { blocks } = JSON.parse(fs.readFileSync(path.join(path.dirname(datasetFile), entry.prepared), 'utf8'));
    console.log(`${path.basename(entry.file)} (${blocks.length} Teile): bisherige Suche …`);
    const baseline = await run('baseline', blocks);
    console.log(`${path.basename(entry.file)}: Kontur-Nesting …`);
    const native = await run('native', blocks);
    let continuation;
    if (continueSeconds) {
      const initialLayout = createPackingStartLayout(native.placements, blocks, 1400, 180);
      if (!initialLayout) throw Error('Startlösung konnte nicht übernommen werden');
      console.log(`${path.basename(entry.file)}: Weiter optimieren …`);
      continuation = await run('native', blocks, initialLayout, continueSeconds);
      if (continuation.lengthMm > native.lengthMm + .0001) throw Error('Weiteroptimieren hat das Ergebnis verschlechtert');
      delete continuation.placements;
    }
    delete baseline.placements; delete native.placements;
    const row = { continuation, file: path.basename(entry.file), pieces: blocks.length, baseline, native,
      continuedSavedMm: continuation ? native.lengthMm - continuation.lengthMm : undefined,
      savedMm: baseline.lengthMm - native.lengthMm, savedPercent: 100 * (baseline.lengthMm - native.lengthMm) / baseline.lengthMm };
    rows.push(row);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ widthMm: 1400, rotations: [0, 180], gapMm: 0, secondsPerEngine: seconds, seed: 42, workers, continuationSeconds: continueSeconds, baselineModule: options['baseline-module'] || 'raster-only',
      module: JSON.parse(fs.readFileSync(path.join(root, 'dist/animatus-module.json'), 'utf8')), rejected: dataset.rejected, rows }, null, 2));
    console.log(`  ${baseline.lengthMm.toFixed(1)} → ${native.lengthMm.toFixed(1)} mm (${row.savedPercent.toFixed(2)} %), ${native.acceptedNativeSolutions} native Verbesserungen`);
    if (continuation) console.log(`  Weiter optimiert: ${continuation.lengthMm.toFixed(1)} mm (${row.continuedSavedMm.toFixed(1)} mm zusätzlich gespart)`);
  }
  console.log(`Bericht: ${output}`);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
