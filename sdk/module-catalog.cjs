const { validatePackage } = require('./module-installation.cjs');
const { catalogRelease } = require('./module-trust.cjs');

async function readCatalog(url, fetch) {
  const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok || !response.body) throw new Error(`Modulkatalog ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error('Modulkatalog zu groß');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const catalog = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(catalog.modules) || catalog.modules.length > 1000) throw new Error('Ungültiger Modulkatalog');
  return catalog.modules;
}

async function resolveModule({ module: id, operation }, {
  systemCatalogURL, globalCatalogURL, systemFetch, globalFetch = globalThis.fetch,
  bundled = [], platform = process.platform, arch = process.arch
}) {
  const compatible = entries => {
    for (const entry of entries) {
      if (entry?.id !== id) continue;
      try {
        validatePackage(entry);
        if (entry.operations.includes(operation)
          && (!entry.platforms || entry.platforms.includes(platform))
          && (!entry.architectures || entry.architectures.includes(arch))) return entry;
      } catch (error) { console.error('[module-catalog]', id, error.message); }
    }
    return null;
  };
  // A valid system package wins. Only a missing/incompatible catalog/package tries global.
  for (const [url, fetch] of [[systemCatalogURL, systemFetch], [globalCatalogURL, globalFetch]]) {
    if (!url || !fetch) continue;
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password || !['https:', 'http:'].includes(parsed.protocol)
        || (url === globalCatalogURL && parsed.protocol !== 'https:')) throw new Error('Ungültige Katalogadresse');
      const match = compatible(await readCatalog(url, fetch));
      if (match) return catalogRelease(match, url);
    } catch (error) { console.error('[module-catalog]', error.message); }
  }
  return compatible(bundled);
}

module.exports = { readCatalog, resolveModule };
