// File identities only: a response must never be reused across a device,
// journal revision, import, preference, timezone, or price-table change.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
async function sessionViewKey(trackerDir, options) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify([path.resolve(trackerDir), options]));
  async function inspect(file, recurse = false) {
    let stat;
    try { stat = await fs.stat(file, { bigint: true }); }
    catch (e) { if (e.code === 'ENOENT') { hash.update(file + ':missing'); return; } throw e; }
    hash.update(`${file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}\0`);
    if (recurse && stat.isDirectory()) {
      for (const entry of (await fs.readdir(file, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() || /\.(?:json|jsonl|journal)$/.test(entry.name)) await inspect(path.join(file, entry.name), entry.isDirectory());
      }
    }
  }
  try {
    for (const name of ['fork-history', 'webdav/imports', 'webdav/recovery', 'local-usage-imports']) await inspect(path.join(trackerDir, name), true);
    for (const name of ['fork-prefs.json', 'fork-view.json', 'webdav/config.json', 'webdav/state.json', 'session.queue.jsonl', 'session.queue.jsonl.meta.json']) await inspect(path.join(trackerDir, name));
    return hash.digest('hex');
  } catch { return null; } // inaccessible/changing inventory must not pin a cached answer
}
module.exports = { sessionViewKey };
