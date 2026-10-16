import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.argv.includes('--help'))console.log('pnpm run build:mac\nBaut das native DXF-Modul auf diesem Mac nach dist/. Veröffentlichung anschließend mit pnpm run deploy.');
else if(process.argv.slice(2).filter(arg=>arg!=='--').length) {console.error('Unbekannte Option. Nutze --help.');process.exitCode=1;}
else if(process.platform!=='darwin') {console.error('Diesen Build auf einem Mac ausführen.');process.exitCode=1;}
else execFileSync(process.execPath,[fileURLToPath(new URL('./build.mjs',import.meta.url)),'--native'],{stdio:'inherit'});
