import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import path from 'node:path';
export function requireCargo({env=process.env,run=spawnSync}={}) {
  const name=process.platform==='win32' ? 'cargo.exe' : 'cargo';
  const candidates=env.CARGO?[env.CARGO]:[name,path.join(env.CARGO_HOME||path.join(homedir(),'.cargo'),'bin',name)];
  for(const command of candidates) {
    const result=run(command,['--version'],{env,encoding:'utf8'});
    if(!result.error && result.status===0)return command;
  }
  throw Error('Für den nativen Build wird Rust >= 1.90 benötigt. Unter macOS: pnpm run setup:mac. Alternativ installiere Rust und stelle cargo im PATH bereit oder setze CARGO auf die Cargo-Datei.');
}
