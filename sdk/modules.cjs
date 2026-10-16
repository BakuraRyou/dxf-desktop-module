const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const { moduleRunTimeout } = require('./module-run-limits.cjs');

function manifest(directory) {
  const value = JSON.parse(fs.readFileSync(path.join(directory, 'animatus-module.json'), 'utf8'));
  if (value.apiVersion !== 1 || !/^[a-z][a-z0-9-]{1,63}$/.test(value.id)
      || typeof value.name !== 'string' || !value.name.trim() || typeof value.version !== 'string'
      || !Array.isArray(value.operations) || !value.operations.length
      || value.operations.some(operation => !/^[a-z][a-z0-9-]{0,63}$/.test(operation))
      || (value.kind !== 'system-app' && (typeof value.entry !== 'string' || !value.entry.endsWith('.cjs')))) {
    throw new Error('Das Modul enthält keine gültige Animatus-Modulbeschreibung.');
  }
  for (const field of ['platforms', 'architectures']) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some(item => typeof item !== 'string'))) {
      throw new Error('Die Zielsysteme des Moduls sind ungültig.');
    }
  }
  const root = fs.realpathSync(directory);
  if (value.kind === 'system-app') {
    if (!/^\/admin\/[a-z0-9/-]+$/.test(value.launchPath || '') || value.launchPath.includes('..')
      || value.operations.length !== 1 || value.operations[0] !== 'open') throw new Error('Ungültiger System-App-Einstieg.');
    return { ...value, directory: root };
  }
  const entry = fs.realpathSync(path.resolve(root, value.entry));
  if (!entry.startsWith(root + path.sep) || !fs.statSync(entry).isFile()) {
    throw new Error('Die Moduldatei muss innerhalb des Modulordners liegen.');
  }
  return { ...value, entry, directory: root };
}

function requireCompatible(info) {
  if ((info.platforms && !info.platforms.includes(process.platform))
    || (info.architectures && !info.architectures.includes(process.arch))) {
    throw new Error('Dieses Modul passt nicht zu deinem Betriebssystem oder Prozessor.');
  }
}

class LocalModules {
  constructor({ directory, builtins = [] }) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.modules = new Map();
    this.jobs = new Map();
    this.builtins = new Set();
    this.stateFile = path.join(directory, '.module-state.json');
    this.state = fs.existsSync(this.stateFile) ? JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) : {};
    for (const root of builtins) this.add(root);
    for (const id of this.modules.keys()) this.builtins.add(id);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try { this.add(path.join(directory, entry.name)); }
      catch (error) { console.error('[module]', entry.name, error.message); }
    }
  }
  add(directory) {
    const info = manifest(directory);
    requireCompatible(info);
    if (this.modules.has(info.id)) throw new Error('Ein Modul mit diesem Namen ist bereits vorhanden.');
    this.modules.set(info.id, info);
    return info;
  }
  list() {
    return [...this.modules.values()].map(({ id, name, version, operations, kind, launchPath }) => ({ id, name, version, operations,
      ...(kind === 'system-app' ? {kind, launchPath} : {}),
      enabled: this.state[id]?.enabled !== false, builtin: this.builtins.has(id),
      source: this.state[id]?.source || (this.builtins.has(id) ? 'bundled' : 'external') }));
  }
  writeState(next) {
    const temporary = this.stateFile + '.' + randomUUID();
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.stateFile);
      this.state = next;
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  manage(id, action) {
    const info = this.modules.get(id);
    if (!info || !['enable', 'disable', 'remove'].includes(action)) throw new Error('Wähle ein vorhandenes Modul und eine passende Aktion.');
    if ([...this.jobs.values()].some(job => job.module === id)) throw new Error('Für dieses Modul läuft noch eine Berechnung. Beende sie und versuche es noch einmal.');
    const next = { ...this.state };
    if (action === 'remove') {
      if (this.builtins.has(id)) throw new Error('Dieses mitgelieferte Modul gehört zur Desktop App. Du kannst es deaktivieren.');
      const removed = path.join(this.directory, '.removed-' + randomUUID());
      fs.renameSync(info.directory, removed);
      delete next[id];
      try { this.writeState(next); }
      catch (error) { fs.renameSync(removed, info.directory); throw error; }
      this.modules.delete(id);
      try { fs.rmSync(removed, { recursive: true, force: true }); }
      catch (error) { console.error('[module-remove-cleanup]', error.message); }
    } else this.writeState({ ...next, [id]: { ...next[id], enabled: action === 'enable' } });
    return this.list();
  }
  install(source, { replace = false, origin = 'external' } = {}) {
    const info = manifest(source);
    requireCompatible(info);
    const previous = this.modules.get(info.id);
    if (previous && !replace) throw new Error('Dieses Modul ist bereits hinzugefügt.');
    const target = path.join(this.directory, info.id);
    if (previous && (!fs.existsSync(target) || previous.directory !== fs.realpathSync(target))) {
      throw new Error('Dieses mitgelieferte Modul wird mit der App aktualisiert.');
    }
    if (previous && [...this.jobs.values()].some(job => job.module === info.id)) {
      throw new Error('Für dieses Modul läuft noch eine Berechnung. Beende sie und versuche es noch einmal.');
    }
    // Copy a self-contained module; do not run install scripts or accept symlinks.
    let total = 0;
    function inspect(root) {
      for (const item of fs.readdirSync(root, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Error('Modulordner dürfen keine symbolischen Links enthalten.');
        const target = path.join(root, item.name);
        if (item.isDirectory()) inspect(target);
        else if (item.isFile()) total += fs.statSync(target).size;
        else throw new Error('Der Modulordner enthält eine nicht unterstützte Datei.');
        if (total > 4 * 1024 * 1024 * 1024) throw new Error('Der Modulordner ist größer als 4 GB.');
      }
    }
    inspect(source);
    const temporary = path.join(this.directory, `.install-${randomUUID()}`);
    const backup = path.join(this.directory, `.previous-${randomUUID()}`);
    let backedUp = false;
    let moved = false;
    try {
      fs.cpSync(source, temporary, { recursive: true, dereference: false });
      const staged = manifest(temporary);
      if (staged.id !== info.id || staged.version !== info.version) throw new Error('Der Modulordner wurde während der Installation verändert.');
      if (previous) { fs.renameSync(target, backup); backedUp = true; }
      fs.renameSync(temporary, target);
      moved = true;
      const installed = manifest(target);
      this.writeState({ ...this.state, [info.id]: { enabled: this.state[info.id]?.enabled !== false, source: origin } });
      this.modules.set(info.id, installed);
    } catch (error) {
      if (moved) fs.rmSync(target, { recursive: true, force: true });
      if (backedUp) fs.renameSync(backup, target);
      throw error;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    if (backedUp) {
      try { fs.rmSync(backup, { recursive: true, force: true }); }
      catch (error) { console.error('[module-update-cleanup]', error.message); }
    }
    return this.list();
  }
  run({ module: id, operation, input, jobId = randomUUID() }, { onProgress = () => {}, onMessage = () => {}, owner } = {}) {
    const info = this.modules.get(id);
    if (!info || !info.operations.includes(operation)) throw new Error('Diese lokale Berechnung ist nicht verfügbar.');
    if (info.kind === 'system-app') throw new Error('Öffne dieses Modul in deinem verbundenen System.');
    if (this.state[id]?.enabled === false) throw new Error('Dieses Modul ist deaktiviert. Aktiviere es im Modul-Marktplatz.');
    if (typeof jobId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(jobId) || this.jobs.has(jobId)) {
      throw new Error('Die Berechnung benötigt eine eindeutige Auftragskennung.');
    }
    if (this.jobs.size >= 2) throw new Error('Es laufen bereits zwei Berechnungen. Versuche es gleich noch einmal.');
    return new Promise((resolve, reject) => {
      const worker = new Worker(info.entry, { workerData: { jobId, operation, input },
        resourceLimits: { maxOldGenerationSizeMb: 512 } });
      const job = { worker, owner, module: id, operation, cancelling: false };
      this.jobs.set(jobId, job);
      let done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(job.cancelTimer);
        this.jobs.delete(jobId);
        void worker.terminate();
        if (error) {
          if (job.cancelling) {
            const aborted = new Error('Berechnung abgebrochen.');
            aborted.name = 'AbortError'; aborted.code = 'ERR_MODULE_CANCELLED';
            reject(aborted);
          } else {
            console.error('[module]', id, { jobId, operation, message: error.message });
            reject(new Error('Die lokale Berechnung konnte nicht abgeschlossen werden.'));
          }
        }
        else resolve(result);
      };
      // Long contour searches remain cancellable, with a bounded total runtime.
      const timer = setTimeout(() => this.cancel(jobId, owner, 'time-limit'), moduleRunTimeout(id, operation, input));
      onProgress({ jobId, module: id, progress: 0 });
      worker.on('message', message => {
        if (job.cancelling) {
          if (message?.type === 'cancelled') finish(new Error('Berechnung abgebrochen'));
          return;
        }
        if (message?.type === 'progress') onProgress({ jobId, module: id, progress: message.value });
        else if (message?.type === 'event') onMessage({ jobId, module: id, data: message.value });
        else if (message?.type === 'result') finish(null, message.value);
        else if (message?.type === 'error') finish(new Error(String(message.message)));
      });
      worker.on('error', error => finish(error));
      worker.on('exit', code => { if (!done) finish(new Error(`Worker beendet: ${code}`)); });
    });
  }
  message(jobId, data, owner) {
    const job = this.jobs.get(jobId);
    if (!job || job.owner !== owner || job.cancelling) return false;
    job.worker.postMessage({ type: 'message', value: data });
    return true;
  }
  async cancel(jobId, owner, reason = 'requested') {
    const job = this.jobs.get(jobId);
    if (!job || job.owner !== owner) return false;
    if (!job.cancelling) {
      job.cancelling = true;
      console.info('[module-cancel]', { module: job.module, operation: job.operation, jobId, reason });
      // Give modules a chance to release native subprocesses before terminating.
      job.worker.postMessage({ type: 'cancel' });
      job.cancelTimer = setTimeout(() => void job.worker.terminate(), 500);
    }
    return true;
  }
  async stop() {
    await Promise.allSettled([...this.jobs].map(async ([id, job]) => {
      const exited = new Promise(resolve => job.worker.once('exit', resolve));
      await this.cancel(id, job.owner, 'shutdown');
      await exited;
    }));
  }
}

module.exports = { LocalModules, manifest };
