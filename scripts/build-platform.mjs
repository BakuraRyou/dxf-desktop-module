import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export function buildModule(platform=process.platform,{host=process.platform,run=execFileSync}={}){
 if(!['darwin','win32','linux'].includes(platform))throw Error('Unbekanntes Zielsystem.');
 if(platform!==host)throw Error('Den nativen Modulbuild auf dem Zielsystem '+platform+' ausführen.');
 run(process.execPath,[fileURLToPath(new URL('./build.mjs',import.meta.url)),'--native'],{stdio:'inherit'});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2).filter(arg=>arg!=='--');
 if(args.includes('--help'))console.log('Im DXF-Package: pnpm run build:mac | build:win | build:linux\nBaut nativ auf dem jeweiligen Zielsystem. Veröffentlichung mit pnpm run deploy (baut vorher erneut).');
 else try{if(args.some(arg=>!arg.startsWith('--platform=')))throw Error('Unbekannte Option.');buildModule(args.find(arg=>arg.startsWith('--platform='))?.slice(11)||process.platform);}catch(error){console.error(error.message);process.exitCode=1;}
}
