const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { manifest } = require('./modules.cjs');
const { validatePackage, packagePath } = require('./module-installation.cjs');

function packageModule(source, baseURL, output) {
  const root = fs.realpathSync(source);
  const target = path.resolve(output);
  if (target === root || target.startsWith(root + path.sep) || root.startsWith(target + path.sep)) {
    throw new Error('Quell- und Ausgabeordner müssen getrennt sein.');
  }
  const base = new URL(baseURL.endsWith('/') ? baseURL : baseURL + '/');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('Bitte gib eine HTTPS-Adresse für die veröffentlichten Dateien an.');
  }
  const info = manifest(root);
  const files = [];
  function collect(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      packagePath(name);
      if (entry.isSymbolicLink()) throw new Error('Symbolische Links werden nicht unterstützt.');
      if (entry.isDirectory()) collect(path.join(directory, entry.name), name);
      else if (entry.isFile()) {
        const filename = path.join(root, name);
        const info = fs.statSync(filename);
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const handle = fs.openSync(filename, 'r');
        try {
          let length;
          while ((length = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
        } finally { fs.closeSync(handle); }
        files.push({ path: name, bytes: info.size, executable: !!(info.mode & 0o111),
          sha256: hash.digest('hex'), url: new URL(name, base).href });
      } else throw new Error('Nicht unterstützte Moduldatei.');
    }
  }
  collect(root);
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'animatus-module.json'), 'utf8'));
  const descriptor = validatePackage({ id: info.id, name: info.name, version: info.version, apiVersion: 1,
    entry: raw.entry, operations: info.operations, files,
    ...(raw.kind ? {kind:raw.kind,launchPath:raw.launchPath} : {}),
    ...(raw.platforms ? { platforms: raw.platforms } : {}),
    ...(raw.architectures ? { architectures: raw.architectures } : {}) });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(root, path.join(target, 'files'), { recursive: true, errorOnExist: true, force: false });
  fs.writeFileSync(path.join(target, 'catalog-entry.json'), JSON.stringify(descriptor, null, 2) + '\n');
  return descriptor;
}

if (require.main === module) {
  const [source, baseURL, output] = process.argv.slice(2);
  if (!source || !baseURL || !output) {
    console.error('Aufruf: npm run module:package -- <Modulordner> <HTTPS-Dateiquelle> <Ausgabeordner>');
    process.exitCode = 1;
  } else {
    try {
      const descriptor = packageModule(source, baseURL, output);
      console.log(`${descriptor.name} ${descriptor.version}: ${descriptor.files.length} Dateien vorbereitet. Nicht veröffentlicht.`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
module.exports = { packageModule };
