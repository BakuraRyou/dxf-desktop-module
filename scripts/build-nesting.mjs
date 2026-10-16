import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, cpSync, copyFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {requireCargo} from './rust-toolchain.mjs';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'native/sparrow');
const binary = process.platform === 'win32' ? 'animatus-nesting.exe' : 'animatus-nesting';
function fingerprint(directory, hash = createHash('sha256')) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (['target', '.git', 'Cargo.lock'].includes(entry.name) && directory.endsWith('vendor')) continue;
    if (['target', '.git'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) fingerprint(file, hash);
    else if (entry.isFile()) { hash.update(path.relative(source, file)); hash.update(readFileSync(file)); }
  }
  return hash;
}
export function buildNesting(output) {
  const digest = fingerprint(source).digest('hex');
  const cache = path.join(root, '.temp', `nesting-${process.platform}-${process.arch}-${digest.slice(0, 20)}`);
  if (!existsSync(path.join(cache, binary)) || !existsSync(path.join(cache, 'licenses/sources.json'))) {
    const cargo=requireCargo();
    const manifest = path.join(source, 'Cargo.toml');
    execFileSync(cargo, ['build', '--release', '--locked', '--manifest-path', manifest], { stdio: 'inherit' });
    const metadata = JSON.parse(execFileSync(cargo, ['metadata', '--locked', '--format-version=1', '--manifest-path', manifest], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    const staging = cache + '.staging'; rmSync(staging, { recursive: true, force: true });
    mkdirSync(path.join(staging, 'licenses'), { recursive: true });
    copyFileSync(path.join(metadata.target_directory, 'release', binary), path.join(staging, binary));
    const sources = [];
    for (const pkg of metadata.packages) {
      const directory = path.dirname(pkg.manifest_path), destination = path.join(staging, 'licenses', `${pkg.name}-${pkg.version}`);
      mkdirSync(destination, { recursive: true });
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && /^(license|copying|notice|copyright)/i.test(entry.name)) copyFileSync(path.join(directory, entry.name), path.join(destination, entry.name));
      }
      if (pkg.license_file && existsSync(path.join(directory, pkg.license_file))) copyFileSync(path.join(directory, pkg.license_file), path.join(destination, 'LICENSE-file'));
      // Supply unmodified MPL dependency source along with the binary.
      if (/MPL|LGPL|GPL/.test(pkg.license || '')) cpSync(directory, path.join(destination, 'source'), { recursive: true, filter: file => path.basename(file) !== 'target' });
      sources.push({ name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository,
        source: pkg.source ? `https://crates.io/crates/${pkg.name}/${pkg.version}` : pkg.name === 'sparrow' ? 'https://github.com/JeroenGar/sparrow/tree/v0.3.0' : 'Animatus native/sparrow/src' });
    }
    writeFileSync(path.join(staging, 'licenses/sources.json'), JSON.stringify(sources, null, 2));
    cpSync(staging, cache, { recursive: true }); rmSync(staging, { recursive: true, force: true });
  }
  copyFileSync(path.join(cache, binary), path.join(output, binary)); chmodSync(path.join(output, binary), 0o755);
  cpSync(path.join(cache, 'licenses'), path.join(output, 'licenses/nesting'), { recursive: true });
  return { solver: 'sparrow', version: '0.3.0', geometry: 'jagua-rs 1.0.0', platform: process.platform, architecture: process.arch };
}
