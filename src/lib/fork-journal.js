// Incremental persistence for large fork-owned snapshots. Legacy JSON remains
// the compacted base; checksummed, newline-committed transactions contain only
// changed rows. Missing source rows are retained by callers' upsert policies.
//
// Consistency rules (SYNC_DESIGN / HANDOFF-1.5.0 §2):
//   - Every read-modify-commit transaction runs inside ONE cross-process lock
//     (withTransaction / update). Writing with the lock only around the final
//     put is not enough and is not used.
//   - A torn final append is not a committed transaction; the next writer
//     truncates that tail under the lock. A complete record that fails its
//     checksum is corruption: reads fail loudly, the next write quarantines
//     the journal and rebuilds from the base so the store self-heals without
//     pretending the tail never existed.
//   - A change larger than the compaction budget rewrites the base directly
//     instead of appending a transaction that would be compacted right away.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { openLock } = require('./fs');
const MIN_BASE_BYTES = 256 * 1024;
const COMPACTION_FLOOR_BYTES = 1024 * 1024;
const caches = new Map();
const pending = new Map();
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
let cacheBytes = 0;
const JOURNAL_CORRUPT = 'FORK_JOURNAL_CORRUPT';
function descriptor(file) {
  const name = path.basename(file), parent = path.basename(path.dirname(file));
  if (name === 'fork-cost-basis.json' || (parent === 'fork-history' && name === 'session-groups.json')) return { type: 'object' };
  if (parent === 'fork-history' && (name === 'sessions.json' || /^wire-(buckets|projects|sessions|prefs)\.json$/.test(name))) {
    return { type: 'array', kind: name === 'sessions.json' ? 'sessions' : name.slice(5, -5) };
  }
  if (/^(buckets|projects|sessions|prefs)\.json$/.test(name) && /[/\\]webdav[/\\](imports|recovery)[/\\]/.test(file)) return { type: 'envelope', kind: name.slice(0, -5) };
  return null;
}
function rowKey(kind, r) {
  if (kind === 'sessions') return r.session_hash;
  if (kind === 'prefs') return r.id;
  if (kind === 'projects') return `${r.project_key}|${r.source}|${r.hour_start}`;
  return r.kind === 'account_session_state' ? `state|${r.source}|${r.session_id}` : `${r.source}|${r.model}|${r.hour_start}`;
}
function split(value, shape) {
  if (shape.type === 'object') return { entries: Object.entries(value || {}), meta: null };
  const rows = shape.type === 'envelope' ? value?.rows || [] : value || [];
  const meta = shape.type === 'envelope' ? Object.fromEntries(Object.entries(value || {}).filter(([k]) => k !== 'rows')) : null;
  return { entries: rows.map(r => [rowKey(shape.kind, r), r]), meta };
}
function join(map, meta, shape) {
  if (shape.type === 'object') return Object.fromEntries(map);
  return shape.type === 'envelope' ? { ...meta, rows: [...map.values()] } : [...map.values()];
}
async function stat(file) {
  try { return await fs.stat(file, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const stamp = s => s ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : '-';
async function signature(file) {
  const [base, log] = await Promise.all([stat(file), stat(file + '.journal')]);
  return { key: stamp(base) + '/' + stamp(log), bytes: Number(base?.size || 0n) + Number(log?.size || 0n) };
}
function invalidate(file) {
  const old = caches.get(file); if (old) cacheBytes -= old.bytes;
  caches.delete(file);
}
function putCache(file, entry) {
  invalidate(file);
  if (entry.bytes > MAX_CACHE_BYTES) return;
  caches.set(file, entry); cacheBytes += entry.bytes;
  while (cacheBytes > MAX_CACHE_BYTES) invalidate(caches.keys().next().value);
}
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const compactionBudget = baseBytes => Math.max(COMPACTION_FLOOR_BYTES, baseBytes / 2);
async function load(file, fallback) {
  const shape = descriptor(file);
  for (let tries = 0; tries < 8; tries++) {
    const before = await signature(file), cached = caches.get(file);
    if (cached?.key === before.key) return cached;
    let value;
    try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') value = fallback; else if (e instanceof SyntaxError) throw Object.assign(new Error(`Fork snapshot base is not valid JSON: ${path.basename(file)}`), { code: JOURNAL_CORRUPT }); else throw e; }
    let text = '';
    try { text = await fs.readFile(file + '.journal', 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    let completeBytes = 0;
    if (text) {
      const state = split(value, shape), map = new Map(state.entries); let meta = state.meta;
      // A torn final append is not a committed transaction; a subsequent
      // writer truncates only that tail while holding the cross-process lock.
      const end = text.lastIndexOf('\n');
      const complete = end < 0 ? '' : text.slice(0, end + 1);
      completeBytes = Buffer.byteLength(complete);
      const lines = complete.split('\n').filter(Boolean);
      for (let index = 0; index < lines.length; index++) {
        let record, txn;
        try {
          record = JSON.parse(lines[index]);
          if (typeof record.payload !== 'string' || digest(record.payload) !== record.sha256) throw new Error('checksum');
          txn = JSON.parse(record.payload);
        } catch (e) {
          // Corruption of a complete record must be loud and recoverable: the
          // base JSON is intact and the next write quarantines the journal.
          throw Object.assign(new Error(`Fork journal record ${index + 1}/${lines.length} failed verification for ${path.basename(file)}; base is preserved and the next write quarantines the journal`), { code: JOURNAL_CORRUPT, cause: e });
        }
        if (txn.version !== 1 || txn.type !== shape.type || !Array.isArray(txn.set) || !Array.isArray(txn.remove)) throw Object.assign(new Error(`Unsupported fork journal transaction for ${path.basename(file)}`), { code: JOURNAL_CORRUPT });
        for (const key of txn.remove) map.delete(key);
        for (const [key, row] of txn.set) map.set(key, row);
        if (shape.type === 'envelope') meta = txn.meta;
      }
      value = join(map, meta, shape);
    }
    const after = await signature(file);
    // Readers racing compaction must not combine an old base with a new log.
    if (after.key !== before.key) continue;
    const entry = { ...after, value, completeBytes };
    putCache(file, entry); return entry;
  }
  throw new Error('Fork snapshot changed repeatedly while reading');
}
async function read(file, fallback) {
  // Coalesce parsing only. Each consumer receives its own mutable value.
  let task = pending.get(file);
  if (!task) {
    task = load(file, fallback); pending.set(file, task);
    task.finally(() => { if (pending.get(file) === task) pending.delete(file); }).catch(() => {});
  }
  return structuredClone((await task).value);
}
const LOCK_RETRY_MS = 25, LOCK_TIMEOUT_MS = 60_000;
async function acquire(file) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = performance.now() + LOCK_TIMEOUT_MS; let lease;
  while (!(lease = await openLock(file + '.lock', { quietIfLocked: true }))) {
    if (performance.now() > deadline) throw new Error('Fork snapshot is busy');
    await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
  }
  return lease;
}
// Multi-file transactions acquire their locks in one global (sorted) order so
// overlapping transactions can never deadlock. Every caller that updates more
// than one snapshot must go through here, never two separate write() calls.
async function withTransaction(files, work) {
  const list = [...new Set(files)].sort();
  const leases = [];
  try {
    for (const file of list) leases.push(await acquire(file));
    return await work();
  } finally {
    for (const lease of leases.reverse()) await lease.release().catch(() => {});
  }
}
async function writeUnlocked(file, data, atomicWrite) {
  const shape = descriptor(file);
  const fallbackFor = () => shape.type === 'object' ? {} : shape.type === 'envelope' ? { rows: [] } : [];
  let previous;
  try {
    previous = await load(file, fallbackFor());
  } catch (e) {
    if (e?.code !== JOURNAL_CORRUPT) throw e;
    // Recovery keeps the corrupt journal for inspection and rebuilds the
    // logical view from the untouched base. Rows that lived only in the
    // quarantined tail are re-established by the caller's own merge.
    await fs.rename(file + '.journal', `${file}.journal.corrupt-${Date.now()}`).catch(() => {});
    invalidate(file);
    previous = await load(file, fallbackFor());
  }
  const prior = split(previous.value, shape), next = split(data, shape);
  const old = new Map(prior.entries), incoming = new Map(next.entries);
  const changed = next.entries.filter(([key, row]) => !old.has(key) || JSON.stringify(old.get(key)) !== JSON.stringify(row));
  const removed = prior.entries.filter(([key]) => !incoming.has(key)).map(([key]) => key);
  if (!changed.length && !removed.length && JSON.stringify(prior.meta) === JSON.stringify(next.meta) && await stat(file)) return;
  const base = await stat(file);
  if (!base || (Number(base.size) < MIN_BASE_BYTES && !await stat(file + '.journal'))) {
    await atomicWrite(file, data); invalidate(file); return;
  }
  const payload = JSON.stringify({ version: 1, type: shape.type, set: changed, remove: removed, meta: next.meta });
  const line = JSON.stringify({ payload, sha256: digest(payload) }) + '\n';
  const lineBytes = Buffer.byteLength(line);
  // A transaction at least as large as the compaction budget would append and
  // then rewrite the base anyway; write the base once instead.
  if (lineBytes >= compactionBudget(Number(base.size))) {
    await atomicWrite(file, data); invalidate(file); return;
  }
  const handle = await fs.open(file + '.journal', 'a+', 0o600);
  try {
    if (Number((await handle.stat()).size) !== previous.completeBytes) await handle.truncate(previous.completeBytes);
    await handle.writeFile(line); await handle.sync();
  } finally { await handle.close(); }
  invalidate(file);
  if (previous.completeBytes + lineBytes >= compactionBudget(Number(base.size))) {
    // Both operations are atomic renames under the writer lock. Replaying the
    // old journal over the new base is idempotent if interrupted between them.
    await atomicWrite(file, data);
    await atomicWrite(file + '.journal', '', true);
    invalidate(file);
  }
}
module.exports = { handles: file => Boolean(descriptor(file)), read, withTransaction, withLock: (file, work) => withTransaction([file], work), writeUnlocked, invalidate, JOURNAL_CORRUPT };
