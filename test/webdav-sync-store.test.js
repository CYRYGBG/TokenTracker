// Core fork sync-store tests: document format integrity, exporter build,
// import idempotency, and the cross-device merge rules (per-device SUM vs
// account-level dedup). These are the acceptance-critical invariants from
// docs/fork/REQUIREMENTS.md §6 — runs entirely on local fixtures.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  serializeDocument,
  parseDocument,
  baseFileName,
  segmentFileName,
  parseDocFileName,
} = require("../src/lib/sync-store/format");
const exporter = require("../src/lib/sync-store/exporter");
const { createDeviceImportStore, mergeBucketsAcrossDevices } = require("../src/lib/sync-store/importer");

function bucketRow(overrides = {}) {
  return {
    source: "codex",
    model: "gpt-5.4",
    hour_start: "2026-10-25T14:00:00.000Z",
    input_tokens: 100,
    output_tokens: 50,
    cached_input_tokens: 10,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 20,
    total_tokens: 180,
    total_cost_usd: 0.01,
    conversation_count: 2,
    ...overrides,
  };
}

// --- format -----------------------------------------------------------------

test("document round-trips and validates rows + checksum", () => {
  const rows = [bucketRow(), bucketRow({ hour_start: "2026-10-25T14:30:00.000Z" })];
  const text = serializeDocument({ kind: "buckets", device: "machine-a", seq: 3, sinceSeq: 2, rows });
  const parsed = parseDocument(text);
  assert.equal(parsed.header.fork_sync, 1);
  assert.equal(parsed.header.kind, "buckets");
  assert.equal(parsed.header.device, "machine-a");
  assert.equal(parsed.header.seq, 3);
  assert.equal(parsed.header.since_seq, 2);
  assert.equal(parsed.header.rows, 2);
  assert.deepEqual(parsed.rows, rows);
});

test("truncated files fail validation instead of importing partial rows", () => {
  const rows = [bucketRow(), bucketRow(), bucketRow()];
  const text = serializeDocument({ kind: "buckets", device: "machine-a", seq: 1, rows });
  const truncated = text.slice(0, Math.floor(text.length * 0.6));
  assert.throws(() => parseDocument(truncated), (error) => error.code === "WEBDAV_DOC_INVALID");
});

test("tampered payload fails the checksum", () => {
  const text = serializeDocument({ kind: "buckets", device: "machine-a", seq: 1, rows: [bucketRow()] });
  const lines = text.split("\n");
  const tamperedRow = JSON.stringify(bucketRow({ total_tokens: 999999 }));
  const tampered = [lines[0], tamperedRow, ...lines.slice(2)].join("\n");
  assert.throws(() => parseDocument(tampered), /checksum/);
});

test("future format versions are rejected with a version code", () => {
  const rows = [bucketRow()];
  const header = JSON.stringify({ fork_sync: 99, kind: "buckets", device: "d", seq: 1, rows: 1, sha256: "x" });
  const text = `${header}\n${rows.map((r) => JSON.stringify(r)).join("\n")}\n${JSON.stringify({ end: true })}\n`;
  assert.throws(() => parseDocument(text), (error) => error.code === "WEBDAV_DOC_VERSION");
});

test("file names parse and pad consistently", () => {
  assert.equal(baseFileName("buckets", 42), "buckets-base-0000000042.jsonl");
  assert.equal(segmentFileName("projects", 7), "projects-seg-0000000007.jsonl");
  assert.deepEqual(parseDocFileName("buckets-seg-0000000042.jsonl"), { kind: "buckets", variant: "seg", seq: 42 });
  assert.equal(parseDocFileName("random.txt"), null);
  assert.equal(parseDocFileName("buckets-base-1.jsonl"), null);
});

// --- exporter ----------------------------------------------------------------

test("readLocalBuckets applies last-wins per key and separates session states", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-sync-export-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const first = bucketRow({ total_tokens: 180, total_cost_usd: 0.01 });
    const revised = bucketRow({ total_tokens: 120, total_cost_usd: 0.005 });
    const state = {
      kind: "account_session_state",
      source: "trae-cn",
      session_id: "ses-1",
      model: "trae-cn-x",
      bucket_start: "2026-10-25T10:00:00.000Z",
      input_tokens: 5,
      output_tokens: 6,
      total_tokens: 11,
      snapshot_verified_at: "2026-10-25T10:05:00.000Z",
    };
    const stateOld = { ...state, total_tokens: 4, snapshot_verified_at: "2026-10-25T09:00:00.000Z" };
    await fs.writeFile(
      queuePath,
      [first, revised, { kind: "account_sync_watermark", at: "x" }, state, stateOld]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
      "utf8",
    );
    const { buckets, sessionStates } = exporter.readLocalBuckets(queuePath);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].total_tokens, 120, "later row for the same key wins, including downward");
    assert.equal(sessionStates.length, 1);
    assert.equal(sessionStates[0].total_tokens, 11, "strictly newer snapshot_verified_at wins");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("project rows with credential hints are redacted before export", () => {
  const row = {
    project_key: "owner/repo",
    project_ref: "https://user:secret@github.com/owner/repo.git",
    source: "codex",
    hour_start: "2026-10-25T14:00:00.000Z",
    total_tokens: 10,
  };
  const sanitized = exporter.sanitizeProjectRow(row);
  assert.equal(sanitized.project_ref, null);
  assert.equal(sanitized.credential_redacted, true);
  const clean = exporter.sanitizeProjectRow({ ...row, project_ref: "https://github.com/owner/repo" });
  assert.equal(clean.project_ref, "https://github.com/owner/repo");
  assert.equal(exporter.containsCredentialHint("git@github.com:owner/repo.git"), true);
});

test("diffRowsByKey only emits rows whose content changed", () => {
  const previous = [bucketRow(), bucketRow({ hour_start: "2026-10-25T14:30:00.000Z", total_tokens: 5 })];
  const next = [
    bucketRow(), // unchanged
    bucketRow({ hour_start: "2026-10-25T14:30:00.000Z", total_tokens: 9 }), // revised
    bucketRow({ hour_start: "2026-10-25T15:00:00.000Z" }), // new
  ];
  const changed = exporter.diffRowsByKey({ rows: next, previous, rowKeyOf: exporter.bucketRowKey });
  assert.equal(changed.length, 2);
  assert.ok(changed.some((row) => row.hour_start === "2026-10-25T14:30:00.000Z" && row.total_tokens === 9));
  assert.ok(changed.some((row) => row.hour_start === "2026-10-25T15:00:00.000Z"));
});

// --- importer -----------------------------------------------------------------

async function withImportsDir(run) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-sync-import-"));
  try {
    await run(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test("import store applies documents idempotently and replays are no-ops", async () => {
  await withImportsDir(async (importsDir) => {
    const store = createDeviceImportStore({ importsDir, machineId: "machine-b" });
    const rows1 = [bucketRow()];
    const doc1 = parseDocument(
      serializeDocument({ kind: "buckets", device: "machine-b", seq: 1, rows: rows1 }),
    );
    const first = await store.applyDocument(doc1);
    assert.equal(first.applied, true);
    const replay = await store.applyDocument(doc1);
    assert.equal(replay.applied, false);
    assert.equal(replay.reason, "at-or-below-high-water");

    const rows2 = [bucketRow({ total_tokens: 300, total_cost_usd: 0.02 }), bucketRow({ hour_start: "2026-10-25T16:00:00.000Z" })];
    const doc2 = parseDocument(
      serializeDocument({ kind: "buckets", device: "machine-b", seq: 2, sinceSeq: 1, rows: rows2 }),
    );
    await store.applyDocument(doc2);
    const merged = await store.readMergedBuckets();
    assert.equal(merged.length, 2);
    const revised = merged.find((row) => row.hour_start === "2026-10-25T14:00:00.000Z");
    assert.equal(revised.total_tokens, 300, "same key replaced, not summed");
  });
});

test("import store keeps projects documents separate from buckets", async () => {
  await withImportsDir(async (importsDir) => {
    const store = createDeviceImportStore({ importsDir, machineId: "machine-b" });
    await store.applyDocument(parseDocument(serializeDocument({
      kind: "buckets", device: "machine-b", seq: 1,
      rows: [bucketRow()],
    })));
    await store.applyDocument(parseDocument(serializeDocument({
      kind: "projects", device: "machine-b", seq: 1,
      rows: [{ project_key: "owner/repo", project_ref: "https://github.com/owner/repo", source: "codex", hour_start: "2026-10-25T14:00:00.000Z", total_tokens: 42 }],
    })));
    assert.equal((await store.readMergedBuckets()).length, 1);
    const projects = await store.readMergedProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].project_key, "owner/repo");
  });
});

// --- cross-device merge ---------------------------------------------------------

test("per-device sources sum across devices; both devices' consumption counts", () => {
  const local = [bucketRow({ device: "machine-a", total_tokens: 100 })];
  const remote = [{ machineId: "machine-b", rows: [bucketRow({ device: "machine-b", total_tokens: 60 })] }];
  const merged = mergeBucketsAcrossDevices({ localRows: local, remoteDevices: remote });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].total_tokens, 160);
  assert.deepEqual(merged[0].devices, ["machine-a", "machine-b"]);
});

test("cursor account-level rows dedup by whole-row MAX instead of summing", () => {
  const local = [bucketRow({ device: "machine-a", source: "cursor", model: "cursor-agent", total_tokens: 1000 })];
  const remote = [{
    machineId: "machine-b",
    rows: [bucketRow({ device: "machine-b", source: "cursor", model: "cursor-agent", total_tokens: 700 })],
  }];
  const merged = mergeBucketsAcrossDevices({ localRows: local, remoteDevices: remote });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].total_tokens, 1000, "same account measured from two machines counts once (MAX)");
});

test("trae-cn session states LWW across devices then aggregate", () => {
  const stateA = {
    kind: "account_session_state", source: "trae-cn", session_id: "ses-shared", model: "trae-model",
    bucket_start: "2026-10-25T10:00:00.000Z",
    input_tokens: 10, output_tokens: 10, cached_input_tokens: 0,
    cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 20,
    snapshot_verified_at: "2026-10-25T10:10:00.000Z",
  };
  const stateB = {
    ...stateA, total_tokens: 35, input_tokens: 15, output_tokens: 20,
    snapshot_verified_at: "2026-10-25T11:00:00.000Z",
  };
  const merged = mergeBucketsAcrossDevices({
    localRows: [stateA],
    remoteDevices: [{ machineId: "machine-b", rows: [stateB] }],
  });
  const row = merged.find((r) => r.source === "trae-cn");
  assert.ok(row, "aggregated account row exists");
  assert.equal(row.total_tokens, 35, "strictly newer snapshot replaces older (not summed)");
});

test("re-importing the same device data does not change the merged view", () => {
  const local = [bucketRow({ device: "machine-a" })];
  const remote = [{ machineId: "machine-b", rows: [bucketRow({ device: "machine-b", hour_start: "2026-10-25T15:00:00.000Z" })] }];
  const once = mergeBucketsAcrossDevices({ localRows: local, remoteDevices: remote });
  const twice = mergeBucketsAcrossDevices({ localRows: local, remoteDevices: remote });
  assert.equal(once.length, twice.length);
  assert.equal(
    once.reduce((acc, row) => acc + row.total_tokens, 0),
    twice.reduce((acc, row) => acc + row.total_tokens, 0),
  );
});
