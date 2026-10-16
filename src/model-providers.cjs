const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const IDS = ['nester', 'rl4co'];
const exits = new Set();
const waitForExit = () => Promise.all([...exits]);
function inside(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw Error('Model path must be relative');
  const resolved = fs.realpathSync(path.resolve(root, relative));
  if (!resolved.startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(resolved).isFile()) throw Error('Invalid model file');
  return resolved;
}
function providers(directory) {
  try {
    const root = path.join(directory, 'models');
    if (!fs.realpathSync(root).startsWith(fs.realpathSync(directory) + path.sep)) return [];
    const file = path.join(root, 'models.json');
    if (fs.statSync(file).size > 128000) return [];
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (config.schemaVersion !== 1 || !Array.isArray(config.models)
      || (config.platform && config.platform !== process.platform)
      || (config.architecture && config.architecture !== process.arch)) return [];
    return IDS.flatMap(id => {
      try {
        const entries = config.models.filter(model => model.id === id);
        if (entries.length !== 1) return [];
        const model = entries[0];
        if (!['python', 'node', 'bundled'].includes(model.runtime) || model.task !== 'fixed-width-strip-v1'
          || model.supportsRotationRestrictions !== true || !Number.isInteger(model.maxPieces)
          || model.maxPieces < 1 || model.maxPieces > 2000) return [];
        const executable = model.runtime === 'bundled' ? inside(root, model.executable)
          : model.runtime === 'python' && model.interpreter ? inside(root, model.interpreter) : undefined;
        const entry = model.runtime === 'bundled' && !model.entry ? undefined : inside(root, model.entry);
        return [{ ...model, root, executable, entry, checkpoint: inside(root, model.checkpoint) }];
      } catch { return []; }
    });
  } catch { return []; }
}

function invoke(model, request, { signal, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error('Abgebrochen'));
    const executable = model.runtime === 'node' ? process.execPath : model.executable
      || (process.env.ANIMATUS_DXF_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'));
    const environment = { ...process.env, ...(model.runtime === 'node' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
    if (model.executable) {
      delete environment.PYTHONHOME;
      delete environment.PYTHONPATH;
      environment.PYTHONNOUSERSITE = '1';
    }
    const child = spawn(executable, model.entry ? [model.entry] : [], {
      cwd: model.root, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: environment,
    });
    let exited;
    const exit = new Promise(resolveExit => { exited = resolveExit; });
    exits.add(exit);
    child.once('close', () => { exits.delete(exit); exited(); });
    let settled = false, output = '', diagnostics = '';
    const kill = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const finish = (error, result, terminate = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (terminate) kill();
      if (error) { console.warn('[dxf-model]', model.id, error.message, diagnostics); reject(error); }
      else resolve(result);
    };
    const abort = () => finish(Error('Abgebrochen'));
    const timer = setTimeout(() => finish(Error('Model time budget exhausted')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', error => finish(error));
    child.stdin.on('error', () => {});
    child.stdout.on('data', data => {
      output += data.toString();
      if (output.length > 4 * 1024 * 1024) finish(Error('Model output too large'));
    });
    child.stderr.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-4096); });
    child.on('close', code => {
      if (settled) return;
      try {
        if (code !== 0) throw Error(`Model exited with ${code}`);
        const result = JSON.parse(output);
        if (result.schemaVersion !== 1 || result.model !== model.id || result.trained !== true) throw Error('Unverified model response');
        finish(null, result, false);
      } catch (error) { finish(error, null, false); }
    });
    child.stdin.end(JSON.stringify({ schemaVersion: 1, model: model.id, checkpoint: model.checkpoint, ...request }));
  });
}

async function inspectModels(directory, signal) {
  const installed = providers(directory);
  const models = [];
  for (const id of IDS) {
    const model = installed.find(candidate => candidate.id === id);
    if (!model) { models.push({ id, ready: false }); continue; }
    try {
      const result = await invoke(model, { action: 'status' }, { signal });
      models.push({ id, ready: result.ready === true, maxPieces: model.maxPieces });
    } catch { models.push({ id, ready: false, maxPieces: model.maxPieces }); }
  }
  return { ready: models.every(model => model.ready), reason: models.every(model => model.ready) ? undefined : 'missing-models', models };
}

async function collectCandidates(directory, input, signal) {
  const installed = providers(directory);
  if (installed.length !== 2 || installed.some(model => input.blocks.length > model.maxPieces)) {
    throw Error('Die Modellkombination ist für diese Teile noch nicht verfügbar. Prüfe die Modelle in den Bounding-Einstellungen oder wähle die adaptive Suche.');
  }
  const timeoutMs = Math.max(100, Math.min(30000, Math.floor(input.extreme.timeBudgetMs / 4)));
  const result = { orders: [], layouts: [] };
  for (const model of installed) {
    const response = await invoke(model, { action: 'predict', input: {
      blocks: input.blocks, fabricWidth: input.fabricWidth, rotationStep: input.rotationStep,
      targetLengthMm: input.targetLengthMm, timeBudgetMs: timeoutMs,
    } }, { signal, timeoutMs });
    if (model.id === 'rl4co' && (!Array.isArray(response.orders) || !response.orders.length)) throw Error('RL4CO lieferte keine Reihenfolge.');
    if (model.id === 'nester' && (!Array.isArray(response.layouts) || !response.layouts.length)) throw Error('Nester lieferte keine Anordnung.');
    if (response.orders) result.orders.push(...response.orders);
    if (response.layouts) result.layouts.push(...response.layouts);
  }
  if (result.orders.length > 128 || result.layouts.length > 32) throw Error('Zu viele Modellvorschläge.');
  return result;
}

module.exports = { inspectModels, collectCandidates, waitForExit };
