// Dedicated coverage for the fork incremental snapshot journal
// (src/lib/fork-journal.js). Production defaults are pinned here: the
// 256 KiB journal threshold, the max(1 MiB, base/2) compaction budget and
// the cross-process lock contract from HANDOFF-1.5.0 §2.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const repo = path.join(__dirname, "..");
const durable = require(path.join(repo, "src/lib/fork-store"));
const { JOURNAL_CORRUPT } = durable;

// Realistic ~1.6 KiB session rows so fixtures cross the production thresholds.
function sessionRow(index, total = 1000 + index, extra = {}) {
  return {
    session_hash: `hash-${String(index).padStart(6, "0")}`,
    session_id: `id-${index}`,
    source: "codex",
    model: "test-model",
    started_at: "2026-07-01T00:00:00.000Z",
    ended_at: "2026-07-01T00:10:00.000Z",
    tokens: { input_tokens: total, output_tokens: 0, total_tokens: total },
    total_tokens: total,
    usage_buckets: Array.from({ length: 8 }, (_, k) => ({
      hour_start: `2026-07-01T0${k}:00:00.000Z`,
      input_tokens: 100 + index + k,
      output_tokens: 5 + k,
      cached_input_tokens: 3,
      cache_creation_input_tokens: 2,
      reasoning_output_tokens: 1,
      total_tokens: 111 + index + k,
    })),
    model_usage: [
      { model: "test-model", input_tokens: total, output_tokens: 0, total_tokens: total },
    ],
    ...extra,
  };
}
const ROWS_OVER_10MIB = 6500;
async function statOf(file) {
  try {
    return await fs.stat(file, { bigint: true });
  } catch {
    return null;
  }
}
const footprint = async (file) => {
  const [base, log] = await Promise.all([statOf(file), statOf(`${file}.journal`)]);
  return {
    baseBytes: Number(base?.size || 0n),
    baseMtime: String(base?.mtimeNs || ""),
    journalBytes: Number(log?.size || 0n),
    journalMtime: String(log?.mtimeNs || ""),
  };
};
// Row payloads travel via a file: Windows child environments cap out far
// below the size of a large synthetic fixture.
function runChild(env) {
  const script = `
    const store = require(process.env.TT_STORE);
    const fs = require("node:fs/promises");
    (async () => {
      const mode = process.env.TT_MODE;
      if (mode === "retain") {
        const rows = JSON.parse(await fs.readFile(process.env.TT_ROWS_FILE, "utf8"));
        await store.retain(process.env.TT_TRACKER, "sessions", rows, r => r.session_hash);
      } else if (mode === "read-loop") {
        const deadline = Date.now() + Number(process.env.TT_MS || 1500);
        let last = -1, samples = 0;
        while (Date.now() < deadline) {
          const rows = await store.read(process.env.TT_FILE, []);
          const row = rows.find(r => r.session_hash === "race-row");
          const total = row ? row.total_tokens : 0;
          if (total < last) { console.log(JSON.stringify({ regression: true, last, total })); process.exit(3); }
          last = total; samples++;
          await new Promise(r => setTimeout(r, 3));
        }
        console.log(JSON.stringify({ ok: true, samples, last }));
      }
    })().then(() => process.exit(0), e => { console.error(String(e && e.message)); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, ...env, TT_STORE: path.join(repo, "src/lib/fork-store.js") },
    encoding: "utf8",
    timeout: 60_000,
  });
  return result;
}

test("sessions journal: one revision in a >=10 MiB history writes only the delta and reads back exactly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-big-"));
  try {
    const file = path.join(dir, "fork-history", "sessions.json");
    const rows = [];
    for (let i = 0; i < ROWS_OVER_10MIB; i++) rows.push(sessionRow(i));
    await durable.write(file, rows);
    const initial = await footprint(file);
    assert.ok(initial.baseBytes >= 10 * 1024 * 1024, `fixture should exceed 10 MiB, got ${initial.baseBytes}`);
    assert.equal(initial.journalBytes, 0, "no journal before the first incremental change");
    const revised = rows.map(r => (r.session_hash === "hash-002500" ? sessionRow(2500, 4242) : r));
    await durable.write(file, revised);
    const after = await footprint(file);
    assert.ok(after.journalBytes > 0, "revision must be recorded in the journal");
    assert.ok(after.journalBytes < 4096, `journal should hold one row, got ${after.journalBytes} bytes`);
    assert.equal(after.baseBytes, initial.baseBytes, "base stays untouched for a small change");
    const readBack = await durable.read(file, []);
    assert.equal(readBack.length, ROWS_OVER_10MIB);
    assert.equal(readBack.find(r => r.session_hash === "hash-002500").total_tokens, 4242);
    assert.equal(readBack.find(r => r.session_hash === "hash-000001").usage_buckets.length, 8, "unchanged rows keep their content");
    // Missing-source retention: a scan that no longer observes most rows must
    // not shrink the durable history. Real callers commit through retain's
    // union, never a bare replacement with a subset.
    await durable.retain(dir, "sessions", [sessionRow(2500, 4242)], r => r.session_hash);
    const retained = await durable.read(file, []);
    assert.equal(retained.length, ROWS_OVER_10MIB, "absent keys are never deletions");
    assert.equal(retained.find(r => r.session_hash === "hash-000499").total_tokens, 1000 + 499);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions journal: an identical second commit writes nothing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-idem-"));
  try {
    const file = path.join(dir, "fork-history", "sessions.json");
    const rows = Array.from({ length: 300 }, (_, i) => sessionRow(i));
    await durable.write(file, rows);
    await durable.write(file, rows.map(r => (r.session_hash === "hash-000010" ? sessionRow(10, 999) : r)));
    const before = await footprint(file);
    const same = rows.map(r => (r.session_hash === "hash-000010" ? sessionRow(10, 999) : r));
    await durable.write(file, same);
    await durable.write(file, same);
    const after = await footprint(file);
    assert.ok(before.journalBytes > 0, "first revision uses the journal");
    assert.equal(after.journalBytes, before.journalBytes, "no new journal bytes for identical input");
    assert.equal(after.journalMtime, before.journalMtime, "journal not touched");
    assert.equal(after.baseMtime, before.baseMtime, "base not rewritten");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions journal: repeated small changes grow the log by their change size and compact under the default budget", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-compact-"));
  try {
    const file = path.join(dir, "fork-history", "sessions.json");
    const rows = Array.from({ length: 300 }, (_, i) => sessionRow(i));
    await durable.write(file, rows);
    const baseSize = (await footprint(file)).baseBytes;
    assert.ok(baseSize >= 256 * 1024, "fixture must exercise the journal branch");
    let appendBytes = 0;
    let compactions = 0;
    let previousJournal = 0;
    for (let round = 0; round < 700; round++) {
      const revised = rows.map(r => (r.session_hash === `hash-${String(round % 300).padStart(6, "0")}` ? sessionRow(round % 300, 5000 + round) : r));
      await durable.write(file, revised);
      const now = await footprint(file);
      if (now.journalBytes < previousJournal) compactions++;
      appendBytes += Math.max(0, now.journalBytes - previousJournal);
      previousJournal = now.journalBytes;
    }
    const final = await footprint(file);
    assert.ok(compactions >= 1, "default compaction budget must have triggered");
    // Compaction is amortized, not synchronized with the last write: the log
    // must stay inside the default budget plus one transaction.
    assert.ok(
      final.journalBytes <= 1024 * 1024 + 8192,
      `journal must stay bounded by the compaction budget, got ${final.journalBytes}`,
    );
    const counterfactual = 700 * baseSize;
    const actual = appendBytes + final.baseBytes;
    assert.ok(
      actual < counterfactual / 2,
      `amortized writes (${actual}) must beat full rewrites (${counterfactual})`,
    );
    const readBack = await durable.read(file, []);
    assert.equal(readBack.find(r => r.session_hash === `hash-${String(699 % 300).padStart(6, "0")}`).total_tokens, 5000 + 699);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions journal: a change at least as large as the compaction budget rewrites the base directly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-direct-"));
  try {
    const file = path.join(dir, "fork-history", "sessions.json");
    const rows = Array.from({ length: 800 }, (_, i) => sessionRow(i));
    await durable.write(file, rows);
    const baseSize = (await footprint(file)).baseBytes;
    assert.ok(baseSize >= 256 * 1024);
    const bulk = rows.map(r => sessionRow(parseInt(r.session_hash.slice(5), 10), 77777));
    await durable.write(file, bulk);
    const now = await footprint(file);
    assert.equal(now.journalBytes, 0, "no oversized transaction is appended");
    const readBack = await durable.read(file, []);
    assert.ok(readBack.every(r => r.total_tokens === 77777));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions journal: torn final append is not committed and the next write repairs it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-torn-"));
  try {
    const file = path.join(dir, "fork-history", "sessions.json");
    const rows = Array.from({ length: 300 }, (_, i) => sessionRow(i));
    await durable.write(file, rows);
    await durable.write(file, rows.map(r => (r.session_hash === "hash-000005" ? sessionRow(5, 555) : r)));
    const good = await durable.read(file, []);
    assert.equal(good.find(r => r.session_hash === "hash-000005").total_tokens, 555);
    // Simulate a crash in the middle of appending the next transaction.
    await fs.appendFile(`${file}.journal`, '{"payload":"');
    const afterTorn = await durable.read(file, []);
    assert.equal(afterTorn.find(r => r.session_hash === "hash-000005").total_tokens, 555, "torn tail is not a commit");
    // The next writer's full state carries the 555 commit forward (callers
    // always build the next value from the prior logical view).
    const carried = rows.map(r => (r.session_hash === "hash-000005" ? sessionRow(5, 555) : r));
    await durable.write(file, carried.map(r => (r.session_hash === "hash-000006" ? sessionRow(6, 666) : r)));
    const healed = await durable.read(file, []);
    assert.equal(healed.find(r => r.session_hash === "hash-000005").total_tokens, 555, "earlier commit survives repair");
    assert.equal(healed.find(r => r.session_hash === "hash-000006").total_tokens, 666, "new commit lands");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions journal: corrupted complete record fails loudly on read and is quarantined by the next write", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-corrupt-"));
  try {
    const file = path.join(dir, "fork-history", "sessions.json");
    const rows = Array.from({ length: 300 }, (_, i) => sessionRow(i));
    await durable.write(file, rows);
    await durable.write(file, rows.map(r => (r.session_hash === "hash-000005" ? sessionRow(5, 555) : r)));
    // Append a complete-looking record whose checksum does not match.
    const payload = JSON.stringify({ version: 1, type: "array", set: [], remove: [], meta: null });
    await fs.appendFile(`${file}.journal`, JSON.stringify({ payload, sha256: "0".repeat(64) }) + "\n");
    await assert.rejects(() => durable.read(file, []), (e) => e.code === JOURNAL_CORRUPT);
    // Recovery keeps the base; the next write rebuilds on top of it.
    const carried = rows.map(r => (r.session_hash === "hash-000005" ? sessionRow(5, 555) : r));
    await durable.write(file, carried.map(r => (r.session_hash === "hash-000007" ? sessionRow(7, 777) : r)));
    const quarantined = await fs.readdir(path.join(dir, "fork-history"));
    assert.ok(quarantined.some(n => n.startsWith("sessions.json.journal.corrupt-")), "corrupt journal preserved for inspection");
    const healed = await durable.read(file, []);
    assert.equal(healed.find(r => r.session_hash === "hash-000005").total_tokens, 555, "base row retained");
    assert.equal(healed.find(r => r.session_hash === "hash-000007").total_tokens, 777);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions journal: an unsupported transaction version is corruption, not empty history", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-version-"));
  try {
    const file = path.join(dir, "fork-history", "sessions.json");
    const rows = Array.from({ length: 300 }, (_, i) => sessionRow(i));
    await durable.write(file, rows);
    const payload = JSON.stringify({ version: 99, type: "array", set: [], remove: [], meta: null });
    await fs.appendFile(`${file}.journal`, JSON.stringify({ payload, sha256: crypto.createHash("sha256").update(payload).digest("hex") }) + "\n");
    await assert.rejects(() => durable.read(file, []), (e) => e.code === JOURNAL_CORRUPT);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(raw.length, 300, "base is intact");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions journal: legacy JSON is the first base; small changes append without rewriting it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-legacy-"));
  try {
    const file = path.join(dir, "fork-history", "sessions.json");
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const legacy = Array.from({ length: 300 }, (_, i) => sessionRow(i));
    await fs.writeFile(file, JSON.stringify(legacy), { mode: 0o600 });
    const legacyStat = await statOf(file);
    await durable.write(file, legacy.map(r => (r.session_hash === "hash-000003" ? sessionRow(3, 303) : r)));
    const after = await statOf(file);
    assert.equal(String(after.mtimeNs), String(legacyStat.mtimeNs), "legacy base bytes stay as the recoverable baseline");
    const readBack = await durable.read(file, []);
    assert.equal(readBack.find(r => r.session_hash === "hash-000003").total_tokens, 303);
    assert.ok(await statOf(`${file}.journal`), "incremental log created for the >=256 KiB base");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions journal: atomic replacement of the base is picked up by the cache", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-atomic-"));
  try {
    const file = path.join(dir, "fork-history", "sessions.json");
    const rows = Array.from({ length: 300 }, (_, i) => sessionRow(i));
    await durable.write(file, rows);
    assert.equal((await durable.read(file, [])).find(r => r.session_hash === "hash-000002").total_tokens, 1002);
    // Same-size rewrite under a new inode: the swap must not be served stale.
    const swapped = rows.map(r => (r.session_hash === "hash-000002" ? sessionRow(2, 2002) : r));
    const tmp = `${file}.swap`;
    await fs.writeFile(tmp, JSON.stringify(swapped), { mode: 0o600 });
    await fs.rename(tmp, file);
    const readBack = await durable.read(file, []);
    assert.equal(readBack.find(r => r.session_hash === "hash-000002").total_tokens, 2002, "same-size rewrite is not stale");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions journal: readers receive their own mutable copy", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-clone-"));
  try {
    const file = path.join(dir, "fork-history", "sessions.json");
    const rows = Array.from({ length: 20 }, (_, i) => sessionRow(i));
    await durable.write(file, rows);
    const first = await durable.read(file, []);
    first[0].total_tokens = -12345;
    first.pop();
    const second = await durable.read(file, []);
    assert.equal(second.length, 20);
    assert.equal(second[0].total_tokens, 1000, "cache value is not polluted by a caller");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions journal: second process reads the latest logical view and its commit survives", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-proc-"));
  try {
    const tracker = dir;
    const file = path.join(tracker, "fork-history", "sessions.json");
    const rows = Array.from({ length: 300 }, (_, i) => sessionRow(i));
    await durable.write(file, rows);
    const childRows = path.join(dir, "child-rows.json");
    await fs.writeFile(childRows, JSON.stringify([...rows.slice(0, 100), sessionRow(100, 4321)]));
    const child = runChild({
      TT_MODE: "retain",
      TT_TRACKER: tracker,
      TT_ROWS_FILE: childRows,
    });
    assert.equal(child.status, 0, `child failed: ${child.stderr}`);
    const afterChild = await durable.read(file, []);
    assert.equal(afterChild.find(r => r.session_hash === "hash-000100").total_tokens, 4321, "second process commit visible");
    assert.equal(afterChild.length, 300, "no rows lost to the child's partial view");
    await durable.write(file, afterChild.map(r => (r.session_hash === "hash-000200" ? sessionRow(200, 8765) : r)));
    const final = await durable.read(file, []);
    assert.equal(final.find(r => r.session_hash === "hash-000100").total_tokens, 4321, "child commit retained");
    assert.equal(final.find(r => r.session_hash === "hash-000200").total_tokens, 8765);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions journal: two concurrent cross-process writers both land without lost updates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-race-"));
  try {
    const tracker = dir;
    const file = path.join(tracker, "fork-history", "sessions.json");
    const rows = Array.from({ length: 300 }, (_, i) => sessionRow(i));
    await durable.write(file, rows);
    const rowsA = path.join(dir, "writer-a.json");
    const rowsB = path.join(dir, "writer-b.json");
    await fs.writeFile(rowsA, JSON.stringify([...rows.slice(0, 150), sessionRow(150, 11111)]));
    await fs.writeFile(rowsB, JSON.stringify([...rows.slice(150), sessionRow(150, 22222)]));
    const results = await Promise.all([
      runChild({ TT_MODE: "retain", TT_TRACKER: tracker, TT_ROWS_FILE: rowsA }),
      runChild({ TT_MODE: "retain", TT_TRACKER: tracker, TT_ROWS_FILE: rowsB }),
    ]);
    for (const [i, r] of results.entries()) assert.equal(r.status, 0, `writer ${i} failed: ${r.stderr}`);
    const merged = await durable.read(file, []);
    assert.equal(merged.length, 300, "both writers' unions survived");
    assert.ok(
      merged.find(r => r.session_hash === "hash-000150").total_tokens === 11111 ||
        merged.find(r => r.session_hash === "hash-000150").total_tokens === 22222,
      "the row holds one complete committed value",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions journal: reads racing writes never observe a regression or partial state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-rw-"));
  try {
    const tracker = dir;
    const file = path.join(tracker, "fork-history", "sessions.json");
    const rows = Array.from({ length: 300 }, (_, i) => sessionRow(i));
    await durable.write(file, [...rows, sessionRow(-1, 0, { session_hash: "race-row" })]);
    const reader = runChild({ TT_MODE: "read-loop", TT_FILE: file, TT_MS: "1500" });
    for (let round = 1; round <= 40; round++) {
      await durable.write(file, rows.map(r => (r.session_hash === "race-row" ? sessionRow(-1, round, { session_hash: "race-row" }) : r)));
      await new Promise(r => setTimeout(r, 15));
    }
    assert.equal(reader.status, 0, `reader failed: ${reader.stderr}`);
    const parsed = JSON.parse(reader.stdout.trim().split("\n").at(-1));
    assert.ok(parsed.ok, "reader never saw a partial or regressed view");
    assert.ok(parsed.samples > 10, `reader actually sampled (${parsed.samples})`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("imports envelope journal: downward revision lands and replays stay idempotent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-envelope-"));
  try {
    const importsDir = path.join(dir, "webdav", "imports");
    const { createDeviceImportStore } = require(path.join(repo, "src/lib/sync-store/importer"));
    const { serializeDocument, parseDocument } = require(path.join(repo, "src/lib/sync-store/format"));
    const store = createDeviceImportStore({ importsDir, machineId: "device-a" });
    // Enough rows to push the merged envelope past the 256 KiB threshold so
    // the second application really exercises the incremental branch.
    const bucketRow = (hour, total, pad = 0) => ({
      source: "codex", model: "m", hour_start: hour, input_tokens: total, output_tokens: 0,
      cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
      total_tokens: total, device: "device-a", note: `pad-${pad}`.padEnd(120, "x"),
    });
    const hours = Array.from({ length: 2700 }, (_, i) => new Date(Date.UTC(2026, 9, 25, 0, i * 3)).toISOString());
    const doc = (seq, sinceSeq, rows) => parseDocument(serializeDocument({ kind: "buckets", device: "device-a", seq, sinceSeq, rows }));
    await store.applyDocument(doc(1, null, hours.map((h, i) => bucketRow(h, 100 + i))));
    await store.applyDocument(doc(2, 1, [bucketRow(hours[0], 40)]));
    const merged = await store.readMergedBuckets();
    assert.equal(merged.length, 2700);
    assert.equal(merged.find(r => r.hour_start === hours[0]).total_tokens, 40, "downward revision wins by sequence");
    const replay = await store.applyDocument(doc(2, 1, [bucketRow(hours[0], 40)]));
    assert.equal(replay.applied, false);
    assert.equal((await store.readMergedBuckets()).find(r => r.hour_start === hours[0]).total_tokens, 40, "replay is a no-op");
    const sidecar = await statOf(path.join(importsDir, "device-a", "buckets.json.journal"));
    assert.ok(sidecar, "production import dir uses the incremental journal");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("small snapshots stay whole-file: production threshold is not silently lowered", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-threshold-"));
  try {
    const file = path.join(dir, "fork-history", "sessions.json");
    const rows = Array.from({ length: 20 }, (_, i) => sessionRow(i));
    await durable.write(file, rows);
    assert.equal(await statOf(`${file}.journal`), null, "sub-256 KiB snapshot writes the base directly");
    await durable.write(file, rows.map(r => (r.session_hash === "hash-000001" ? sessionRow(1, 11) : r)));
    assert.equal(await statOf(`${file}.journal`), null, "still whole-file below the threshold");
    const readBack = await durable.read(file, []);
    assert.equal(readBack.find(r => r.session_hash === "hash-000001").total_tokens, 11);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("backup round-trip through the incremental store keeps journal revisions visible", async () => {
  const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-backup-a-"));
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-backup-b-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-journal-backup-home-"));
  try {
    const backup = require(path.join(repo, "src/lib/fork-backup"));
    const { parseDocument } = require(path.join(repo, "src/lib/sync-store/format"));
    const groupsA = path.join(dirA, "fork-history", "session-groups.json");
    const sessionsA = path.join(dirA, "fork-history", "sessions.json");
    const rows = Array.from({ length: 300 }, (_, i) => sessionRow(i));
    // Mirror collectSessions' committed pair.
    await durable.withTransaction([groupsA, sessionsA], async () => {
      await durable.writeUnlocked(groupsA, Object.fromEntries(rows.map(r => [r.session_hash, [r]])));
      await durable.writeUnlocked(sessionsA, rows);
    });
    await durable.write(path.join(dirA, "fork-history", "wire-prefs.json"), []);
    await fs.mkdir(path.join(dirA, "webdav"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dirA, "queue.jsonl"), "", { mode: 0o600 });
    // Distinct device identities: the machine-id seed file is global on this
    // host, so both fixtures must pin their own ids.
    await fs.writeFile(path.join(dirA, "config.json"), JSON.stringify({ machineId: "device-aaaa" }), { mode: 0o600 });
    await fs.writeFile(path.join(dirB, "config.json"), JSON.stringify({ machineId: "device-bbbb" }), { mode: 0o600 });
    const exported = await backup.exportBackup(dirA, { home });
    const own = exported.devices.find(d => d.documents.sessions);
    const doc = parseDocument(own.documents.sessions);
    assert.equal(doc.rows.length, 300, "export reads the journal-backed logical view");
    assert.equal(doc.rows.find(r => r.session_hash === "hash-000123").total_tokens, 1123);
    // Device B: restore the other device's backup into its import store.
    await fs.mkdir(path.join(dirB, "webdav"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dirB, "queue.jsonl"), "", { mode: 0o600 });
    const restored = await backup.restoreBackup(dirB, exported);
    assert.ok(restored.ok);
    const { createDeviceImportStore } = require(path.join(repo, "src/lib/sync-store/importer"));
    const storeB = createDeviceImportStore({
      importsDir: path.join(dirB, "webdav", "imports"),
      machineId: own.id,
    });
    const merged = await storeB.readMergedSessions();
    assert.equal(merged.length, 300, "restore fills the other device's import view");
    assert.ok(merged.find(r => r.session_hash === "hash-000123"), "journal-backed row is recoverable");
    // Restoring twice is idempotent (missing-records-only policy).
    const again = await backup.restoreBackup(dirB, exported);
    assert.equal(again.added, 0);
  } finally {
    await Promise.all([
      fs.rm(dirA, { recursive: true, force: true }),
      fs.rm(dirB, { recursive: true, force: true }),
      fs.rm(home, { recursive: true, force: true }),
    ]);
  }
});
