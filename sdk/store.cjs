const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);

function systemURL(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Bitte gib eine gültige System-Adresse ein.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Bitte gib eine HTTP- oder HTTPS-Adresse ohne Zugangsdaten ein.');
  }
  url.hash = '';
  return url.href;
}

function scopedURL(base, value) {
  const url = new URL(value, base);
  if (url.origin !== new URL(base).origin || url.username || url.password) {
    throw new Error('Die Adresse gehört nicht zum ausgewählten System.');
  }
  url.hash = '';
  return url.href;
}

function adminURL(value) {
  const url = new URL(systemURL(value));
  url.pathname = '/admin';
  url.search = '';
  url.hash = '';
  return url.href;
}

// One atomic document per profile. A failed write leaves the old document intact.
class Store {
  constructor(root, scope) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = path.join(root, `${hash(scope)}.json`);
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : { schema: 1, resources: {}, files: {} };
    if (this.data.schema !== 1) throw new Error('Unbekannte lokale Datenversion.');
  }

  read() { return clone(this.data); }

  update(fn, {omit = []} = {}) {
    // Migration can remove large sections before cloning, so the main process
    // never copies the tables it is handing off to the cache worker.
    const next = omit.length
      ? clone(Object.fromEntries(Object.entries(this.data).filter(([key]) => !omit.includes(key))))
      : this.read();
    fn(next);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      this.data = next;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return this.read();
  }
}

function sourceURL(base, value) {
  const url = new URL(scopedURL(base, value));url.searchParams.sort();return url.href;
}
module.exports = { Store, hash, systemURL, scopedURL, sourceURL, adminURL };
