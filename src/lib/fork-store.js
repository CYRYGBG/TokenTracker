// Local durable snapshots are independent of the disposable upstream sidecar.
// Whole-record upserts retain absent keys, including after a partial scan.
//
// Consistency contract: a read-modify-commit transaction spanning one or more
// snapshots must run inside withTransaction / update (one cross-process lock
// per file, multi-file locks acquired in sorted order). Plain write() is only
// for whole-value replacement of a single file.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const locks = new Map();
const journal = require("./fork-journal");
async function serial(key, work) {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}
async function read(file, fallback) {
  if (journal.handles(file)) return journal.read(file, fallback);
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
async function writeAtomic(file, data, raw = false) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(raw ? data : JSON.stringify(data));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
async function write(file, data) {
  if (!journal.handles(file)) return writeAtomic(file, data);
  return journal.withLock(file, () => journal.writeUnlocked(file, data, writeAtomic));
}
// Cross-process lock over one or more snapshot files for a full
// read-transform-commit transaction. writeUnlocked is the only way to commit
// journal-handled files while the lock is held.
async function withTransaction(files, work) {
  return journal.withTransaction(files, work);
}
async function update(file, fallback, transform) {
  return serial(file, async () => {
    const run = async () => {
      const next = await transform(await read(file, fallback));
      if (journal.handles(file)) await journal.writeUnlocked(file, next, writeAtomic);
      else await writeAtomic(file, next);
      return next;
    };
    return journal.handles(file) ? journal.withLock(file, run) : run();
  });
}
async function retain(trackerDir, kind, rows, keyOf) {
  const file = path.join(trackerDir, "fork-history", `${kind}.json`);
  return update(file, [], prior => {
    const map = new Map(prior.map(r => [keyOf(r), r]));
    for (const r of rows) if (keyOf(r)) map.set(keyOf(r), r);
    return [...map.values()];
  });
}
module.exports = { read, write, retain, serial, update, withTransaction, handles: file => journal.handles(file), writeUnlocked: (file, data) => journal.writeUnlocked(file, data, writeAtomic), JOURNAL_CORRUPT: journal.JOURNAL_CORRUPT };
