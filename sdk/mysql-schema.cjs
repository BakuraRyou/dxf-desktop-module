const sqlTypes={string:'VARCHAR(255)',text:'LONGTEXT',number:'DOUBLE',boolean:'TINYINT(1)',json:'JSON'};
function validateSchemas(schemas){
 if(!Array.isArray(schemas)||schemas.length>32)throw new Error('Ungültige Datenstruktur.');
 for(const schema of schemas){if(!/^(todo_|dxf_|distributed_)[a-z0-9_]{1,60}$/.test(schema.table)||!['number','string'].includes(schema.id)||!schema.fields||Object.keys(schema.fields).length>100)throw new Error('Ungültige Datenstruktur.');for(const [key,type]of Object.entries(schema.fields))if(!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)||key==='id'||!Object.hasOwn(sqlTypes,type))throw new Error('Ungültiges Datenfeld.');}
 return schemas;
}
async function initializeMysql(connection,schemas){
 validateSchemas(schemas);
 const quote=value=>'`'+value+'`';
 for(const schema of schemas){
  const id=schema.id==='number'?'BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY':'VARCHAR(191) NOT NULL PRIMARY KEY';
  await connection.query('CREATE TABLE IF NOT EXISTS '+quote(schema.table)+' (`id` '+id+') ENGINE=InnoDB');
  const [columns]=await connection.query('SHOW COLUMNS FROM '+quote(schema.table));const existing=new Set(columns.map(c=>c.Field));
  for(const [key,type]of Object.entries(schema.fields))if(!existing.has(key))await connection.query('ALTER TABLE '+quote(schema.table)+' ADD COLUMN '+quote(key)+' '+sqlTypes[type]+' NULL');
 }
}
module.exports={initializeMysql,validateSchemas};
