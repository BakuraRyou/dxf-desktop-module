const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { manifest } = require('./modules.cjs');
const { officialRelease } = require('./module-trust.cjs');

const MAX_BYTES = 4 * 1024 * 1024 * 1024;

function packagePath(value) {
  if (typeof value !== 'string' || value.length > 240 || value.includes('\\')) throw new Error('Ungültiger Modulpfad.');
  const parts = value.split('/');
  if (parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || ['.', '..'].includes(part)
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Ungültiger Modulpfad.');
  }
  return parts;
}

function validatePackage(value) {
  if (!value || !/^[a-z][a-z0-9-]{1,63}$/.test(value.id) || typeof value.name !== 'string'
    || !value.name.trim() || typeof value.version !== 'string' || !value.version.trim()
    || value.apiVersion !== 1 || (value.kind !== 'system-app' && (typeof value.entry !== 'string' || !value.entry.endsWith('.cjs')))
    || !Array.isArray(value.operations) || !value.operations.length
    || value.operations.some(operation => typeof operation !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(operation))
    || !Array.isArray(value.files) || !value.files.length || value.files.length > 20000) {
    throw new Error('Die Modulbeschreibung ist unvollständig.');
  }
  if (value.kind === 'system-app') {
    if (!/^\/admin\/[a-z0-9/-]+$/.test(value.launchPath || '') || value.launchPath.includes('..')
      || value.operations.length !== 1 || value.operations[0] !== 'open') throw new Error('Ungültiger System-App-Einstieg.');
  } else packagePath(value.entry);
  const paths = new Set();
  let size = 0;
  for (const file of value.files) {
    packagePath(file.path);
    const normalized = file.path.toLowerCase();
    if (paths.has(normalized)) throw new Error('Die Modulbeschreibung enthält doppelte Dateien.');
    paths.add(normalized);
    const url = new URL(file.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || (file.executable !== undefined && typeof file.executable !== 'boolean')) {
      throw new Error('Die Modulquelle ist ungültig.');
    }
    size += file.bytes;
  }
  if (size > MAX_BYTES || !paths.has('animatus-module.json') || (value.kind !== 'system-app' && !paths.has(value.entry.toLowerCase()))) {
    throw new Error('Das Modul ist zu groß oder enthält nicht alle benötigten Dateien.');
  }
  for (const file of paths) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (paths.has(parts.slice(0, i).join('/'))) throw new Error('Die Modulbeschreibung enthält widersprüchliche Dateipfade.');
    }
  }
  for (const field of ['platforms', 'architectures']) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some(item => typeof item !== 'string'))) {
      throw new Error('Die Zielsysteme des Moduls sind ungültig.');
    }
  }
  if(value.requirements!==undefined&&(!Array.isArray(value.requirements)||value.requirements.length>20||value.requirements.some(item=>!item||!/^[a-z][a-z0-9-]{1,63}$/.test(item.id)||typeof item.version!=='string'||item.version.length>128)))throw new Error('Ungültige Systemvoraussetzungen.');
  return value;
}

// Packages come only from the app's catalog, never from a URL supplied by a page.
class ModuleInstallation {
  constructor({ modules, catalog = [], resolve, confirm, checkRequirements = async release=>!release.requirements?.length, fetch = globalThis.fetch, onProgress = () => {},
    platform = process.platform, arch = process.arch }) {
    Object.assign(this, { modules, catalog, resolve, confirm, checkRequirements, fetch, onProgress, platform, arch });
    this.requests = new Map();
    this.declined = new Set();
  }

  ensure(request, { scope, isActive = () => true } = {}) {
    const { module: id, operation, retry = false, update = false, system } = request || {};
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(id)
      || typeof operation !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(operation)
      || typeof scope !== 'string' || !scope || typeof retry !== 'boolean' || typeof update !== 'boolean') {
      return Promise.resolve({ available: false, reason: 'unavailable' });
    }
    const installed = this.modules.list().find(info => info.id === id);
    if (installed && !update) return Promise.resolve(installed.enabled === false
      ? { available: false, reason: 'disabled' } : installed.operations.includes(operation)
        ? { available: true, module: installed } : { available: false, reason: 'incompatible' });
    const key = `${scope}:${id}`;
    if (retry) this.declined.delete(key);
    if (this.declined.has(key)) return Promise.resolve({ available: false, reason: 'declined' });
    // Serialize installation globally per module, and return the result per operation.
    let task = this.requests.get(id);
    if (!task) {
      task = Promise.resolve().then(() => this.install(id, { key, scope, operation, isActive, update, system })).finally(() => this.requests.delete(id));
      this.requests.set(id, task);
    }
    return task.then(result => {
      if (!isActive()) return { available: false, reason: 'unavailable' };
      if (result.available && !result.module.operations.includes(operation)) return { available: false, reason: 'incompatible' };
      return result;
    });
  }

  async install(id, { key, scope, operation, isActive, update, system }) {
    let directory;
    try {
      const descriptor = this.resolve ? await this.resolve({ module: id, operation, scope })
        : this.catalog.find(info => info.id === id);
      if (!descriptor) return { available: false, reason: 'unavailable' };
      const release = validatePackage(descriptor);
      if (release.id !== id || !release.operations.includes(operation)) return { available: false, reason: 'incompatible' };
      if ((release.platforms && !release.platforms.includes(this.platform))
        || (release.architectures && !release.architectures.includes(this.arch))) {
        return { available: false, reason: 'incompatible' };
      }
      if (!isActive()) return { available: false, reason: 'unavailable' };
      if(release.requirements?.length&&!await this.checkRequirements(release,{system,scope}))return {available:false,reason:'requirements-missing'};
      const previous = this.modules.list().find(module => module.id === id);
      if (previous?.builtin && update) return { available: false, reason: 'incompatible' };
      const trusted = officialRelease(release);
      const accepted = trusted || await this.confirm(release);
      if (!isActive()) return { available: false, reason: 'unavailable' };
      if (!accepted) {
        this.declined.add(key);
        return { available: false, reason: 'declined' };
      }
      directory = path.join(this.modules.directory, `.download-${randomUUID()}`);
      await fs.mkdir(directory, { mode: 0o700 });
      let downloaded = 0;
      const total = release.files.reduce((sum, file) => sum + file.bytes, 0);
      this.onProgress({ module: id, scope, state: 'installing', downloaded, total });
      for (const file of release.files) {
        if (!isActive()) return { available: false, reason: 'unavailable' };
        const response = await this.fetch(file.url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15 * 60000) }, { scope });
        if (!response.ok || !response.body) throw new Error(`Download ${response.status}`);
        const reader = response.body.getReader();
        const hash = createHash('sha256');
        let length = 0;
        let handle;
        try {
          const target = path.join(directory, ...packagePath(file.path));
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          handle = await fs.open(target, 'wx', file.executable ? 0o700 : 0o600);
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!isActive()) throw new Error('System gewechselt');
            length += value.byteLength;
            downloaded += value.byteLength;
            if (length > file.bytes || downloaded > MAX_BYTES) throw new Error('Moduldatei ist größer als angekündigt');
            hash.update(value);
            let offset = 0;
            while (offset < value.byteLength) {
              const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
              if (!bytesWritten) throw new Error('Moduldatei konnte nicht gespeichert werden');
              offset += bytesWritten;
            }
            this.onProgress({ module: id, scope, state: 'installing', downloaded, total });
          }
        } finally {
          await reader.cancel().catch(() => {});
          await handle?.close();
        }
        if (length !== file.bytes || hash.digest('hex') !== file.sha256) {
          throw new Error('Prüfsumme der Moduldatei stimmt nicht überein');
        }
      }
      const info = manifest(directory);
      if (['id', 'name', 'version', 'apiVersion'].some(field => info[field] !== release[field])
        || (release.kind === 'system-app' ? info.kind !== 'system-app' || info.launchPath !== release.launchPath
          : info.kind === 'system-app' || info.entry !== path.join(directory, ...packagePath(release.entry)))
        || JSON.stringify(info.operations) !== JSON.stringify(release.operations)) {
        throw new Error('Der Inhalt passt nicht zur Modulbeschreibung');
      }
      if (!isActive()) return { available: false, reason: 'unavailable' };
      this.modules.install(directory, { replace: !!previous && update, origin: trusted ? 'official' : 'external' });
      this.onProgress({ module: id, scope, state: 'installed', downloaded, total });
      return { available: true, module: this.modules.list().find(info => info.id === id) };
    } catch (error) {
      console.error('[module-installation]', id, error.message);
      this.onProgress({ module: id, scope, state: 'failed' });
      return { available: false, reason: 'installation-failed' };
    } finally {
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(error => {
        console.error('[module-installation-cleanup]', error.message);
      });
    }
  }
}

module.exports = { ModuleInstallation, validatePackage, packagePath };
