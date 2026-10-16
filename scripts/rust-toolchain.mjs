import {spawnSync} from 'node:child_process';
export function requireCargo({env=process.env,run=spawnSync}={}) {
  const command=env.CARGO || (process.platform==='win32' ? 'cargo.exe' : 'cargo');
  const result=run(command,['--version'],{encoding:'utf8'});
  if(result.error || result.status!==0)throw Error('Für den nativen Build wird Rust >= 1.90 benötigt. Installiere Rust und stelle cargo im PATH bereit oder setze CARGO auf die Cargo-Datei.');
  return command;
}
