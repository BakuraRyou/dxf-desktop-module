const fs=require('node:fs');
const path=require('node:path');
const defaultHost=path.resolve(__dirname,'..');
function configuration(directory=defaultHost) {
  const filename=process.env.ANIMATUS_MARKETPLACE_ENV || path.join(directory,'.env.deploy');
  const env={...(fs.existsSync(filename)?require('dotenv').parse(fs.readFileSync(filename)):{}),...process.env};
  if(env.MYSQL_DATABASE!=='k229934_marketplace' || env.GOOGLE_CLOUD_BUCKET_NAME!=='anim-marktplatz')throw Error('Richte die Marktplatz-Zugänge in .env.deploy ein.');
  const credentials=env.GOOGLE_APPLICATION_CREDENTIALS || (fs.existsSync(path.join(directory,'gcloud.json')) ? path.join(directory,'gcloud.json') : undefined);
  return {env,credentials};
}
function catalogTarget(file) {
  const base=new URL('https://marktplatz.animatus.de/api/file/static/files/marketplace/modules/'),url=new URL(file.url);
  if(url.origin!==base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash)throw Error('Unzulässige Paketquelle.');
  const relative=decodeURIComponent(url.pathname.slice(base.pathname.length));
  if(!relative || relative.includes('\\') || relative.split('/').some(part=>!part || part==='.' || part==='..'))throw Error('Ungültiger Paketpfad.');
  return relative;
}
async function refreshSite(hostRoot = defaultHost) {
  const {env,credentials}=configuration(hostRoot);
  if(!env.NEXTAUTH_SECRET || !env.WEBSITE_SALT)throw Error('Die Zugangsdaten zur Website-Aktivierung fehlen.');
  const {Storage}=require('@google-cloud/storage');
  const [body]=await new Storage(credentials?{keyFilename:credentials}:{}).bucket(env.GOOGLE_CLOUD_BUCKET_NAME).file('settings/modules/components.json').download();
  const url=new URL('https://marktplatz.animatus.de/api/revalidate/tag');
  url.searchParams.set('key',require('jsonwebtoken').sign({salt:env.WEBSITE_SALT},env.NEXTAUTH_SECRET,{expiresIn:'2m'}));
  const request=async payload=>{
    const response=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error('Die Website-Aktivierung ist nicht erreichbar.');
    const result=await response.json();if(result.success!==1)throw new Error('Die Website-Aktivierung wurde nicht bestätigt.');return result;
  };
  const snapshot=await request({inspectModules:true,provider:'gcs'});
  await request({tags:['components','providers','pages','pages-page-json'],expectedRevision:snapshot.moduleRevision,
    artifacts:[{provider:'gcs',key:'settings/modules/components.json',sha256:require('node:crypto').createHash('sha256').update(body).digest('hex')}]});
}

async function publishSite(prepared) {
  const { hostRoot, catalog, assets } = prepared;
  const {env,credentials}=configuration(hostRoot);
  const mysql=require('mysql2/promise');
  const {Storage}=require('@google-cloud/storage');
  const connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT) || 3306,
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, connectTimeout: 10000 });
  let active;
  try {
    await connection.execute(`CREATE TABLE IF NOT EXISTS animatus_marketplace_releases (
      module_id VARCHAR(64) NOT NULL, version VARCHAR(128) NOT NULL, variant VARCHAR(128) NOT NULL,
      descriptor LONGTEXT NOT NULL, active TINYINT NOT NULL DEFAULT 1,
      published_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (module_id, version, variant))`);
    await connection.beginTransaction();
    for (const release of catalog.modules) {
      const variant = JSON.stringify([release.platforms || [], release.architectures || []]);
      await connection.execute('UPDATE animatus_marketplace_releases SET active=0 WHERE module_id=? AND variant=?', [release.id, variant]);
      await connection.execute(`INSERT INTO animatus_marketplace_releases (module_id,version,variant,descriptor,active)
        VALUES (?,?,?,?,1) ON DUPLICATE KEY UPDATE descriptor=VALUES(descriptor),active=1`,
      [release.id, release.version, variant, JSON.stringify(release)]);
    }
    const [rows] = await connection.execute('SELECT descriptor FROM animatus_marketplace_releases WHERE active=1 ORDER BY published_at DESC,module_id');
    active = { modules: rows.map(row => JSON.parse(row.descriptor)) };
    const storage = new Storage(credentials ? {keyFilename:credentials} : {});
    const bucket = storage.bucket(env.GOOGLE_CLOUD_BUCKET_NAME);
    // Publish immutable files before activating their registry/catalog pointers.
    for (const asset of assets) {
      if(!asset.key.startsWith('files/marketplace/modules/') || asset.key.split('/').some(part=>!part || part==='.' || part==='..'))throw Error('Ungültiger Modulpfad.');
      const file = bucket.file(asset.key);
      if (/^files\/marketplace\/(online|modules|source)\//.test(asset.key) && (await file.exists())[0]) continue;
      const body=asset.body;
      await file.save(body, { resumable: false, contentType: asset.key.endsWith('.json') ? 'application/json'
        : asset.key.endsWith('.js') ? 'application/javascript' : asset.key.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
    }
    const catalogBody = Buffer.from(JSON.stringify(active, null, 2) + '\n');
    await bucket.file('files/marketplace/catalog.json').save(catalogBody, { resumable: false, contentType: 'application/json' });
    await bucket.file('files/marketplace/catalog.txt').save(catalogBody, { resumable: false, contentType: 'text/plain; charset=utf-8' });
    await connection.commit();
    try { await refreshSite(hostRoot); }
    catch { console.warn('Marktplatz-Dateien gespeichert; die Website-Aktivierung muss erneut ausgeführt werden.'); }
    console.log(`Marktplatz veröffentlicht: ${active.modules.length} aktive Pakete, Moduldateien in anim-marktplatz.`);
    return active;
  } catch (error) { await connection.rollback().catch(() => {}); throw error; }
  finally { await connection.end(); }
}

module.exports={publishSite,catalogTarget,configuration,defaultHost};
