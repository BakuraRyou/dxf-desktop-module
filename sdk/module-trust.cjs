const MARKETPLACE_URL = 'https://marktplatz.animatus.de/';
const OFFICIAL_CATALOG_URL = new URL('api/file/static/files/marketplace/catalog.txt', MARKETPLACE_URL).href;
const sources = new WeakMap();

function isMarketplaceURL(value) {
  try {
    const url = new URL(value);
    return url.origin === new URL(MARKETPLACE_URL).origin && !url.username && !url.password;
  } catch { return false; }
}

// Trust is assigned by the main-process resolver, never by catalog JSON or IPC.
function catalogRelease(release, source) {
  sources.set(release, source);
  return release;
}
function officialRelease(release, source = sources.get(release)) {
  if (source !== OFFICIAL_CATALOG_URL || !Array.isArray(release.files)) return false;
  return release.files.every(file => {
    const url = new URL(file.url);
    return !url.username && !url.password && (isMarketplaceURL(url.href)
      || (url.origin === 'https://storage.googleapis.com' && url.pathname.startsWith('/anim-marktplatz/')));
  });
}

module.exports = { MARKETPLACE_URL, OFFICIAL_CATALOG_URL, isMarketplaceURL, catalogRelease, officialRelease };
