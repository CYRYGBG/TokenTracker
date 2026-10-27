// Local durable snapshots are independent of the disposable upstream sidecar.
// Whole-record upserts retain absent keys, including after a partial scan.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const locks = new Map();
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
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
async function write(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(data));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
async function retain(trackerDir, kind, rows, keyOf) {
  const file = path.join(trackerDir, "fork-history", `${kind}.json`);
  return serial(file, async () => {
    const prior = await read(file, []);
    const map = new Map(prior.map((r) => [keyOf(r), r]));
    for (const r of rows) if (keyOf(r)) map.set(keyOf(r), r);
    const next = [...map.values()];
    if (JSON.stringify(prior) !== JSON.stringify(next)) await write(file, next);
    return next;
  });
}
module.exports = { read, write, retain, serial };
