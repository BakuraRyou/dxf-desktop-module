import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
export function setupMac({platform=process.platform,env=process.env,run=spawnSync,log=console.log}={}) {
  if(platform!=='darwin')throw Error('Dieser Befehl ist für macOS vorgesehen.');
  const check=(file,args)=>run(file,args,{env,encoding:'utf8'});
  const execute=(file,args)=>{
    const result=run(file,args,{env,stdio:'inherit'});
    if(result.error||result.status!==0)throw Error(`Der Befehl ${file} konnte nicht abgeschlossen werden. Bitte prüfe die Ausgabe und starte pnpm run setup:mac erneut.`);
  };
  if(check('xcode-select',['-p']).status!==0) {
    execute('xcode-select',['--install']);
    throw Error('Bitte schließe die Installation der Xcode Command Line Tools im geöffneten Fenster ab und starte danach pnpm run setup:mac erneut.');
  }
  const cargoHome=env.CARGO_HOME?path.resolve(env.CARGO_HOME):path.join(homedir(),'.cargo');
  const rustup=path.join(cargoHome,'bin','rustup');
  if(check(rustup,['--version']).status!==0) {
    const temporary=mkdtempSync(path.join(tmpdir(),'animatus-rust-'));
    try {
      const installer=path.join(temporary,'rustup-init.sh');
      log('Rust wird über den offiziellen rustup-Installer installiert …');
      execute('curl',['--proto','=https','--tlsv1.2','--fail','--silent','--show-error','--location','https://sh.rustup.rs','--output',installer]);
      execute('sh',[installer,'-y','--profile','minimal','--default-toolchain','none']);
    } finally {rmSync(temporary,{recursive:true,force:true});}
  }
  execute(rustup,['toolchain','install','stable','--profile','minimal']);
  execute(rustup,['override','set','stable','--path',root]);
  execute(rustup,['run','stable','cargo','--version']);
  log('Rust ist bereit. Mit pnpm run build:mac kannst du das Mac-Modul bauen.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {setupMac();} catch(error) {console.error(error.message);process.exitCode=1;}
}
