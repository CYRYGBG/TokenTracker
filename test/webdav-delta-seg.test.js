// Delta segment coverage for HANDOFF-1.5.0 §3: segments carry only rows that
// changed relative to the last SUCCESSFULLY published content, the publish
// baseline only advances after a confirmed upload, and 1.4.20 readers still
// apply the resulting files.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { runSyncCycle, normalizeConfig } = require("../src/lib/webdav/scheduler");
const { serializeDocument, parseDocument, parseDocFileName } = require("../src/lib/sync-store/format");
const { createWebDavTestServer } = require("./helpers/webdav-server");

function bucket(source, model, hour, total, extra = {}) {
  return {
    source, model, hour_start: hour,
    input_tokens: total, output_tokens: 0, cached_input_tokens: 0,
    cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
    total_tokens: total, total_cost_usd: 0, conversation_count: 1,
    ...extra,
  };
}
async function appendQueue(trackerDir, rows) {
  const queuePath = path.join(trackerDir, "queue.jsonl");
  const existing = await fs.readFile(queuePath, "utf8").catch(() => "");
  const lines = rows.map((row) => JSON.stringify(row)).join("\n");
  await fs.writeFile(queuePath, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + lines + "\n", "utf8");
}
async function replaceLastRow(trackerDir, hour, total) {
  const queuePath = path.join(trackerDir, "queue.jsonl");
  const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
  const revised = rows.map((row) => (row.hour_start === hour && row.source !== "zcode" ? { ...row, total_tokens: total, input_tokens: total } : row));
  await fs.writeFile(queuePath, revised.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}
async function cycle(device, state) {
  const result = await runSyncCycle({
    config: device.config,
    password: device.password,
    machineId: device.machineId,
    trackerDir: device.trackerDir,
    state,
  });
  return result;
}
async function deviceDocNames(harness, machineId) {
  const dir = `/tokentracker-fork/devices/${machineId}`;
  return [...harness.state.files.keys()]
    .filter((p) => p.startsWith(`${dir}/`))
    .map((p) => path.basename(p))
    .filter((name) => /^(buckets|projects|sessions|prefs)-(base|seg)-\d+\.jsonl$/.test(name))
    .sort();
}
async function readDoc(harness, machineId, name) {
  const content = harness.state.files.get(`/tokentracker-fork/devices/${machineId}/${name}`);
  return content == null ? null : parseDocument(content);
}
function withDevice(trackerDir, harness) {
  return {
    trackerDir,
    machineId: "machine-a",
    password: "app-password",
    config: { url: harness.baseUrl(), username: "user", directory: "tokentracker-fork", enabled: true },
  };
}

test("a segment after the first base carries only the changed rows; unchanged cycles upload nothing", async () => {
  const harness = createWebDavTestServer();
  await harness.listen();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-delta-seg-"));
  try {
    const hours = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 9, 25, 0, i)).toISOString());
    const tracker = path.join(tmp, "tracker");
    await fs.mkdir(tracker, { recursive: true });
    await appendQueue(tracker, hours.map((h, i) => bucket("codex", "gpt-5.4", h, 100 + i)));
    const device = withDevice(tracker, harness);
    let state = { version: 1, docs: {}, imported: {} };
    const first = await cycle(device, state);
    state = first.state;
    assert.equal(first.ok, true);
    assert.deepEqual(await deviceDocNames(harness, "machine-a"), [
      "buckets-base-0000000001.jsonl", "prefs-base-0000000001.jsonl", "projects-base-0000000001.jsonl", "sessions-base-0000000001.jsonl",
    ]);
    const base = await readDoc(harness, "machine-a", "buckets-base-0000000001.jsonl");
    assert.equal(base.rows.length, 30, "first export is a full base");

    // One revision + one new row.
    await replaceLastRow(tracker, hours[5], 999);
    await appendQueue(tracker, [bucket("codex", "gpt-5.4", new Date(Date.UTC(2026, 9, 25, 1, 0)).toISOString(), 55)]);
    const second = await cycle(device, state);
    state = second.state;
    assert.equal(second.ok, true);
    const names = await deviceDocNames(harness, "machine-a");
    assert.ok(names.includes("buckets-seg-0000000002.jsonl"), `expected a delta segment, got ${names.join(",")}`);
    const seg = await readDoc(harness, "machine-a", "buckets-seg-0000000002.jsonl");
    assert.equal(seg.header.since_seq, 1);
    assert.equal(seg.header.rows, 2, `segment must hold exactly the two changed rows, got ${seg.header.rows}`);
    const segHours = seg.rows.map((row) => row.hour_start).sort();
    assert.deepEqual(segHours, [hours[5], new Date(Date.UTC(2026, 9, 25, 1, 0)).toISOString()].sort());
    assert.equal(seg.rows.find((row) => row.hour_start === hours[5]).total_tokens, 999);

    // Zero-change cycle uploads no new documents.
    const before = (await deviceDocNames(harness, "machine-a")).join(",");
    const third = await cycle(device, state);
    state = third.state;
    assert.equal(third.ok, true);
    assert.equal((await deviceDocNames(harness, "machine-a")).join(","), before, "unchanged cycle uploads nothing");
    assert.deepEqual(third.exported, [], "no kinds planned");
  } finally {
    await harness.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("a failed upload leaves the revision queued and the retry sends it; the baseline never advances early", async () => {
  const harness = createWebDavTestServer();
  await harness.listen();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-delta-retry-"));
  try {
    const tracker = path.join(tmp, "tracker");
    await fs.mkdir(tracker, { recursive: true });
    await appendQueue(tracker, [bucket("codex", "gpt-5.4", "2026-10-25T14:00:00.000Z", 100)]);
    const device = withDevice(tracker, harness);
    let state = { version: 1, docs: {}, imported: {} };
    state = (await cycle(device, state)).state;
    const hashAfterBase = state.docs.buckets.hash;
    const stateAfterBase = JSON.parse(JSON.stringify(state));

    await appendQueue(tracker, [bucket("codex", "gpt-5.4", "2026-10-25T15:00:00.000Z", 200)]);
    harness.state.faults.PUT = { status: 500 };
    await assert.rejects(() => cycle(device, state), /upload buckets failed/);
    delete harness.state.faults.PUT;
    // No baseline advance, no docs advance for buckets.
    assert.equal(state.docs.buckets.seq, 1, "failed upload must not move the recorded seq");
    const published = JSON.parse(await fs.readFile(path.join(tracker, "webdav", "published", "buckets.json"), "utf8"));
    assert.equal(published.seq, 1, "publish baseline only advances after a confirmed upload");

    const retry = await cycle(device, state);
    state = retry.state;
    assert.equal(retry.ok, true);
    assert.ok(retry.exported.includes("buckets"), "the queued revision is sent on retry");
    const seg = await readDoc(harness, "machine-a", "buckets-seg-0000000002.jsonl");
    assert.equal(seg.header.rows, 1);
    assert.equal(seg.rows[0].hour_start, "2026-10-25T15:00:00.000Z");

    // Upload succeeded but the local commit was lost: no re-upload, and the
    // recorded hash converges to the published content. Every kind keeps its
    // pre-crash record; only the in-flight buckets commit is reverted.
    const lostCommitState = JSON.parse(JSON.stringify(stateAfterBase));
    lostCommitState.docs.buckets = { seq: 1, hash: hashAfterBase };
    const before = (await deviceDocNames(harness, "machine-a")).join(",");
    const afterLoss = await cycle(device, lostCommitState);
    assert.equal(afterLoss.ok, true);
    assert.equal((await deviceDocNames(harness, "machine-a")).join(","), before, "already-published rows are not sent again");
    assert.equal(afterLoss.state.docs.buckets.seq, 2, "hash record catches up to the server content");

    // Crash between the upload and the baseline write: next change re-bases
    // from the server content instead of guessing a delta.
    await fs.rm(path.join(tracker, "webdav", "published"), { recursive: true, force: true });
    await appendQueue(tracker, [bucket("codex", "gpt-5.4", "2026-10-25T16:00:00.000Z", 300)]);
    const rebased = await cycle(device, state);
    assert.equal(rebased.ok, true);
    assert.ok((await deviceDocNames(harness, "machine-a")).includes("buckets-base-0000000003.jsonl"), "missing baseline forces a full base");
    const base3 = await readDoc(harness, "machine-a", "buckets-base-0000000003.jsonl");
    assert.equal(base3.rows.length, 3);
  } finally {
    await harness.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("a device restored from an old server state re-bases once and then resumes delta segments", async () => {
  const harness = createWebDavTestServer();
  await harness.listen();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-delta-restore-"));
  try {
    const tracker = path.join(tmp, "tracker");
    await fs.mkdir(tracker, { recursive: true });
    await appendQueue(tracker, [bucket("codex", "gpt-5.4", "2026-10-25T14:00:00.000Z", 100)]);
    const device = withDevice(tracker, harness);
    let state = { version: 1, docs: {}, imported: {} };
    state = (await cycle(device, state)).state;
    // Simulate an OLD-version device that already published a full seg beyond
    // our state (upgrade scenario): the server has buckets-seg-2 with all rows
    // built by the same export pipeline an old client runs (device tag and
    // cost basis included).
    await appendQueue(tracker, [bucket("codex", "gpt-5.4", "2026-10-25T15:00:00.000Z", 70)]);
    const exporter = require("../src/lib/sync-store/exporter");
    const costs = require("../src/lib/fork-costs");
    const oldRows = await costs.capture(
      tracker,
      exporter.buildBucketsRows({ queuePath: path.join(tracker, "queue.jsonl"), machineId: "machine-a" }),
    );
    const fullSeg = serializeDocument({
      kind: "buckets", device: "machine-a", seq: 2, sinceSeq: 1, rows: oldRows,
    });
    harness.state.files.set("/tokentracker-fork/devices/machine-a/buckets-seg-0000000002.jsonl", fullSeg);
    await appendQueue(tracker, [bucket("codex", "gpt-5.4", "2026-10-25T16:00:00.000Z", 30)]);
    const upgraded = await cycle(device, state);
    state = upgraded.state;
    assert.equal(upgraded.ok, true);
    const names = await deviceDocNames(harness, "machine-a");
    assert.ok(names.includes("buckets-base-0000000003.jsonl"), `state behind the server must re-base, got ${names.join(",")}`);
    const base3 = await readDoc(harness, "machine-a", "buckets-base-0000000003.jsonl");
    assert.equal(base3.rows.length, 3, "rebase carries the union including recovered remote rows");
    // From here deltas resume.
    await replaceLastRow(tracker, "2026-10-25T16:00:00.000Z", 31);
    const delta = await cycle(device, state);
    state = delta.state;
    assert.equal(delta.ok, true);
    const seg = await readDoc(harness, "machine-a", "buckets-seg-0000000004.jsonl");
    assert.ok(seg, "delta segments resume after the rebase");
    assert.equal(seg.header.rows, 1);
  } finally {
    await harness.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("the 1.4.20 read side applies new delta segments unchanged", async (t) => {
  const harness = createWebDavTestServer();
  await harness.listen();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-delta-compat-"));
  const legacy = path.join(tmp, "legacy-lib");
  try {
    const tracker = path.join(tmp, "tracker");
    await fs.mkdir(tracker, { recursive: true });
    await appendQueue(tracker, [bucket("codex", "gpt-5.4", "2026-10-25T14:00:00.000Z", 100)]);
    const device = withDevice(tracker, harness);
    let state = { version: 1, docs: {}, imported: {} };
    state = (await cycle(device, state)).state;
    await appendQueue(tracker, [bucket("codex", "gpt-5.4", "2026-10-25T15:00:00.000Z", 200)]);
    await replaceLastRow(tracker, "2026-10-25T14:00:00.000Z", 40);
    state = (await cycle(device, state)).state;
    const seg = await readDoc(harness, "machine-a", "buckets-seg-0000000002.jsonl");
    assert.equal(seg.header.rows, 2, "precondition: delta segment with two rows");

    // Extract the 1.4.20 library exactly as released and run its importer
    // against the new files. git + bsdtar exist on macOS and Windows alike,
    // but a bare Wine prefix has neither — skip there (the read-side contract
    // is platform-independent and verified wherever git is available).
    const { execFileSync, spawnSync } = require("node:child_process");
    if (spawnSync("git", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT") {
      t.skip("git is not on PATH; the 1.4.20 read-side contract is verified on macOS");
      return;
    }
    await fs.mkdir(legacy, { recursive: true });
    const repoRoot = path.resolve(__dirname, "..");
    const archive = path.join(legacy, "lib.tar");
    execFileSync("git", ["archive", "personal-v1.4.20", "--format=tar", "--output=" + archive], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("tar", ["-xf", archive, "-C", legacy], { stdio: "ignore" });
    await fs.rm(archive, { force: true });
    const legacyImporter = require(path.join(legacy, "src/lib/sync-store/importer.js"));
    const importsDir = path.join(tmp, "imports");
    const store = legacyImporter.createDeviceImportStore({ importsDir, machineId: "machine-a" });
    for (const name of ["buckets-base-0000000001.jsonl", "buckets-seg-0000000002.jsonl"]) {
      const doc = parseDocument(harness.state.files.get(`/tokentracker-fork/devices/machine-a/${name}`));
      const applied = await store.applyDocument(doc);
      if (name.endsWith("base-1.jsonl")) assert.equal(applied.applied, true);
    }
    const merged = await store.readMergedBuckets();
    assert.equal(merged.length, 2, "1.4.20 importer merges base + delta seg");
    assert.equal(merged.find((row) => row.hour_start === "2026-10-25T14:00:00.000Z").total_tokens, 40, "downward revision applied");
    assert.equal(merged.find((row) => row.hour_start === "2026-10-25T15:00:00.000Z").total_tokens, 200);
  } finally {
    await harness.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("serializeDocument keeps the fork_sync:1 self-check contract for delta segments", async () => {
  const rows = [bucket("codex", "gpt-5.4", "2026-10-25T14:00:00.000Z", 40)];
  const text = serializeDocument({ kind: "buckets", device: "machine-a", seq: 7, sinceSeq: 6, rows });
  const doc = parseDocument(text);
  assert.equal(doc.header.fork_sync, 1);
  assert.equal(doc.header.kind, "buckets");
  assert.equal(doc.header.device, "machine-a");
  assert.equal(doc.header.seq, 7);
  assert.equal(doc.header.since_seq, 6);
  assert.equal(doc.header.rows, 1);
  assert.equal(doc.header.sha256.length, 64);
  assert.deepEqual(doc.rows, rows);
});
