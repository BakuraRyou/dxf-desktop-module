const {createHash}=require('node:crypto');
function validateSource(source){
 if(!source||typeof source.name!=='string'||!/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(source.name)||!Array.isArray(source.files)||!source.files.length||source.files.length>10000||!Array.isArray(source.packages)||!/^[a-f0-9]{64}$/.test(source.revision))throw new Error('Das Modul enthält keinen vollständigen Quellnachweis.');
 const safe=p=>typeof p==='string'&&p.length<300&&p.startsWith('packages/')&&!p.includes('\\')&&p.split('/').every(s=>s.length>0&&!/[\x00-\x1f\x7f:*?"<>|]/.test(s)&&!['.','..'].includes(s)&&!/[. ]$/.test(s)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s));
 if(!safe(source.entry)||source.packages.length>100||!source.packages.some(p=>p.path===source.entry&&p.name===source.name))throw new Error('Ungültiger Quellpaket-Einstieg.');
 const names=new Set();
 for(const p of source.packages){if(!safe(p.path)||typeof p.name!=='string'||!/^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(p.name)||names.has(p.name))throw new Error('Ungültige Quellpaket-Wurzel.');names.add(p.name);}
 const seen=new Set();let total=0;
 for(const f of source.files){if(!safe(f.path)||seen.has(f.path.toLowerCase())||!source.packages.some(p=>f.path.startsWith(p.path+'/'))||f.path.split('/').some(s=>s.startsWith('.')||['node_modules','.git'].includes(s))||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>32*1024*1024)throw new Error('Ungültige Quelldatei.');const url=new URL(f.url);if(url.href!=='https://marktplatz.animatus.de/api/file/static/files/marketplace/source/'+f.sha256+'.bin')throw new Error('Unzulässige Quellpaket-Adresse.');seen.add(f.path.toLowerCase());total+=f.bytes;}
 if(total>128*1024*1024||!seen.has(source.entry.toLowerCase()+'/modules.json')||!seen.has(source.entry.toLowerCase()+'/package.json'))throw new Error('Das Quellpaket ist unvollständig oder zu groß.');
 if(createHash('sha256').update(JSON.stringify(source.files)).digest('hex')!==source.revision)throw new Error('Ungültige Quellpaket-Prüfsumme.');
 return source;
}
module.exports={validateSource};
