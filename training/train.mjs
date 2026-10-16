import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), policy = require('../src/order-policy.cjs');
const editorRequire = createRequire(new URL('../../dxf-editor-v2/package.json', import.meta.url));
const args = process.argv.slice(2), options = {};
const allowed = ['data', 'output', 'gap', 'width', 'grid', 'epochs', 'samples', 'seed', 'learning-rate', 'compaction-ms', 'timeout-seconds', 'sizes'];
for (const arg of args) {
  if (['--resume', '--prepare-only', '--help'].includes(arg)) { options[arg.slice(2)] = true; continue; }
  const match = arg.match(/^--([^=]+)=(.+)$/);
  if (!match || !allowed.includes(match[1]) || options[match[1]] !== undefined) throw new Error(`Unbekannte oder doppelte Option: ${arg}. Siehe --help.`);
  options[match[1]] = match[2];
}
if (options.help) {
  console.log('DXF-Training: node training/train.mjs --data=<DXF-Ordner> --gap=<Mindestabstand mm> [--output=<Ordner>] [--epochs=10] [--samples=4] [--resume] [--prepare-only]\nVorgaben: 1400 mm Breite, 0°/180°, keine Spiegelung, Millimeter. Weitere Optionen: --width=1400 --grid=5 --seed=42 --learning-rate=0.01 --compaction-ms=250 --timeout-seconds=120 --sizes=40,42');
  process.exit(0);
}
function number(name, fallback, min, max, integer = false) {
  const value = Number(options[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Ungültige Option --${name}`);
  return value;
}
if (!options.data || options.gap === undefined) throw new Error('--data=<Ordner> und --gap=<Mindestabstand mm> sind erforderlich; 0 ist zulässig.');
const config = { width: number('width', 1400, 1, 100000), gap: number('gap', 0, 0, 100), rotation: 180, mirror: false,
  grid: number('grid', 5, 2, 20), samples: number('samples', 4, 2, 32, true), seed: number('seed', 42, 0, 2147483647, true),
  learningRate: number('learning-rate', .01, .000001, 1), compactionMs: number('compaction-ms', 250, 0, 3000, true),
  sizes: options.sizes ? options.sizes.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [] };
const epochs = number('epochs', 10, 1, 100000, true), timeout = number('timeout-seconds', 120, 1, 3600) * 1000;
// npm --prefix changes cwd to the package; paths still belong to the caller.
const invocationDirectory = process.env.INIT_CWD || process.cwd();
const data = fs.realpathSync(path.resolve(invocationDirectory, options.data));
const output = path.resolve(invocationDirectory, options.output || 'dxf-training');
fs.mkdirSync(output, { recursive: true });
const lock = path.join(output, '.training.lock');
try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
catch { throw new Error('Dieser Ausgabeordner ist gesperrt. Prüfe, ob ein Training läuft. Nach einem Rechnerabsturz kann .training.lock manuell entfernt werden.'); }
let active, interrupted = false;
function abort() { interrupted = true; active?.kill('SIGTERM'); }
process.on('SIGINT', abort); process.on('SIGTERM', abort);
function atomic(name, value) {
  const destination = path.join(output, name), temporary = destination + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(temporary, destination);
}
async function work(request) {
  if (interrupted) throw new Error('Training unterbrochen; mit --resume fortsetzen.');
  return new Promise((resolve, reject) => {
    let result, timedOut = false, diagnostics = '';
    const child = fork(fileURLToPath(new URL('worker.ts', import.meta.url)), [], {
      execArgv: ['--import', editorRequire.resolve('tsx')], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json',
    });
    active = child;
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.on('message', message => { result = message; });
    child.on('error', error => { clearTimeout(timer); active = undefined; reject(error); });
    child.on('exit', code => {
      clearTimeout(timer); active = undefined;
      if (interrupted) reject(new Error('Training unterbrochen; mit --resume fortsetzen.'));
      else if (timedOut) reject(new Error(`Zeitlimit von ${timeout / 1000}s überschritten`));
      else if (code !== 0 || !result?.ok) reject(new Error(result?.error || diagnostics || `Trainingsprozess beendet (${code})`));
      else resolve(result);
    });
    child.send({ ...request, config });
  });
}
function findFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && path.resolve(file) !== output) files.push(...findFiles(file));
    else if (entry.isFile() && /\.dxf$/i.test(entry.name)) files.push(file);
  }
  return files;
}
try {
  const files = findFiles(data);
  if (!files.length) throw new Error('Keine DXF-Dateien im Eingabeordner gefunden');
  const unique = new Map();
  for (const file of files) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (!unique.has(hash)) unique.set(hash, { file, hash });
  }
  const inventory = [...unique.values()].sort((a, b) => a.hash.localeCompare(b.hash));
  const signature = crypto.createHash('sha256').update(JSON.stringify({ config, hashes: inventory.map(f => f.hash) })).digest('hex');
  const manifestPath = path.join(output, 'dataset.json');
  const latestPath = path.join(output, 'latest.json');
  if (fs.existsSync(manifestPath) && !options.resume) throw new Error('Ausgabeordner enthält bereits einen Datensatz. --resume oder einen neuen --output-Ordner verwenden.');
  let dataset;
  if (options.resume && fs.existsSync(manifestPath)) {
    dataset = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (dataset.signature !== signature) throw new Error('Dateien oder Trainingsregeln wurden geändert. Verwende einen neuen Ausgabeordner.');
  } else {
    dataset = { schemaVersion: 1, signature, config, files: files.length, duplicates: files.length - inventory.length, accepted: [], rejected: [] };
    fs.mkdirSync(path.join(output, 'prepared'), { recursive: true });
    for (const [i, entry] of inventory.entries()) {
      console.log(`Vorbereitung ${i + 1}/${inventory.length}: ${path.basename(entry.file)}`);
      try {
        const destination = path.join(output, 'prepared', entry.hash + '.json');
        const result = await work({ action: 'prepare', file: entry.file, destination });
        dataset.accepted.push({ ...entry, pieces: result.pieces, units: result.units, prepared: path.relative(output, destination) });
      } catch (error) {
        if (interrupted) throw error;
        dataset.rejected.push({ ...entry, error: error.message }); console.error(`  Übersprungen: ${error.message}`);
      }
    }
    // Split once, before training. Identical content can never cross the split.
    const count = Math.max(1, Math.floor(dataset.accepted.length * .2));
    dataset.accepted.forEach((entry, i) => { entry.split = i < count ? 'validation' : 'train'; });
    atomic('dataset.json', dataset);
  }
  const training = dataset.accepted.filter(f => f.split === 'train'), validation = dataset.accepted.filter(f => f.split === 'validation');
  console.log(`${training.length} Trainingsaufträge, ${validation.length} Bewertungsaufträge, ${dataset.rejected.length} abgelehnt, ${dataset.duplicates} Duplikate. ${config.width} mm, 0°/180°, Abstand ${config.gap} mm, keine Spiegelung.`);
  if (training.length < 1 || validation.length < 1) throw new Error('Mindestens zwei unterschiedliche, gültige DXF-Aufträge werden benötigt. Siehe dataset.json.');
  if (options['prepare-only']) { console.log(`Datensatz geprüft: ${manifestPath}`); }
  else {
    let state = options.resume && fs.existsSync(latestPath) ? JSON.parse(fs.readFileSync(latestPath, 'utf8')) : {
      schemaVersion: 1, signature, model: policy.create(config.seed), epoch: 0, cursor: 0, bestValidation: null, history: [],
    };
    if (state.signature !== signature) throw new Error('Checkpoint gehört zu einem anderen Datensatz');
    policy.validate(state.model);
    while (state.epoch < epochs) {
      for (; state.cursor < training.length;) {
        const entry = training[state.cursor];
        console.log(`Epoche ${state.epoch + 1}/${epochs}, Auftrag ${state.cursor + 1}/${training.length}: ${path.basename(entry.file)}`);
        // A failed/timeout training step aborts without modifying the last durable weights.
        const result = await work({ action: 'train', prepared: path.join(output, entry.prepared), model: state.model,
          seed: config.seed + state.epoch * training.length + state.cursor });
        state.model = result.model; state.cursor++; atomic('latest.json', state);
        console.log(`  Kürzester Versuch: ${result.bestHeight.toFixed(1)} mm`);
      }
      const rows = [];
      for (const [i, entry] of validation.entries()) {
        console.log(`Bewertung ${i + 1}/${validation.length}: ${path.basename(entry.file)}`);
        const result = await work({ action: 'validate', prepared: path.join(output, entry.prepared), model: state.model, seed: config.seed + i });
        rows.push({ file: entry.file, baselineHeight: result.baselineHeight, learnedHeight: result.learnedHeight });
      }
      const baselineMm = rows.reduce((s, r) => s + r.baselineHeight, 0), learnedMm = rows.reduce((s, r) => s + r.learnedHeight, 0);
      const assessment = { epoch: state.epoch + 1, baselineMm, learnedMm, improvementPercent: 100 * (baselineMm - learnedMm) / baselineMm,
        improved: learnedMm < baselineMm - .001, comparison: 'five-heuristic-orders-v1', rows };
      state.history.push(assessment);
      if (state.bestValidation === null || learnedMm < state.bestValidation) {
        state.bestValidation = learnedMm;
        atomic('best-model.json', { ...state.model, config, validation: assessment, datasetSignature: signature,
          maxPieces: Math.max(...dataset.accepted.map(f => f.pieces)), trainingFiles: training.length, validationFiles: validation.length });
      }
      state.epoch++; state.cursor = 0;
      atomic('latest.json', state); atomic('report.json', { config, history: state.history });
      console.log(`Bewertung: ${assessment.improvementPercent.toFixed(2)} % gegenüber fünf festen Reihenfolgen. Noch kein Vergleich gegen die vollständige Extreme-Suche.`);
    }
    console.log(`Training beendet. Gewichte: ${path.join(output, 'best-model.json')}`);
  }
} catch (error) { console.error(error.message); process.exitCode = interrupted ? 130 : 1; }
finally { fs.rmSync(lock, { force: true }); }
