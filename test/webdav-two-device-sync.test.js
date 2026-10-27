// Two-device integration test for the fork WebDAV sync: two isolated tracker
// dirs (like a Mac and a Windows PC) produce queue data, sync through an
// in-memory WebDAV server, and must converge on identical "all devices"
// views — with no double counting across repeated cycles, restarts, or
// account-level sources read from both machines.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { runSyncCycle } = require("../src/lib/webdav/scheduler");
const { createDeviceImportStore, mergeBucketsAcrossDevices } = require("../src/lib/sync-store/importer");
const { createWebDavTestServer } = require("./helpers/webdav-server");

async function withTwoDevices(run) {
  const harness = createWebDavTestServer();
  await harness.listen();
  const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), "tt-device-a-"));
  const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), "tt-device-b-"));
  try {
    const config = {
      url: harness.baseUrl(),
      username: "user",
      directory: "tokentracker-fork",
      enabled: true,
      device_name: null,
    };
    const password = "app-password";
    const deviceA = { machineId: "machine-a", trackerDir: path.join(tmpA, "tracker"), config, password };
    const deviceB = { machineId: "machine-b", trackerDir: path.join(tmpB, "tracker"), config, password };
    for (const device of [deviceA, deviceB]) {
      await fs.mkdir(device.trackerDir, { recursive: true });
    }
    await run({ deviceA, deviceB, harness });
  } finally {
    await harness.close();
    await fs.rm(tmpA, { recursive: true, force: true });
    await fs.rm(tmpB, { recursive: true, force: true });
  }
}

async function appendQueue(trackerDir, rows) {
  const queuePath = path.join(trackerDir, "queue.jsonl");
  const lines = rows.map((row) => JSON.stringify(row)).join("\n");
  const existing = await fs.readFile(queuePath, "utf8").catch(() => "");
  await fs.writeFile(queuePath, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + lines + "\n", "utf8");
}

async function cycle(device, state) {
  return runSyncCycle({
    config: device.config,
    password: device.password,
    machineId: device.machineId,
    trackerDir: device.trackerDir,
    state,
  });
}

async function mergedViewFor(device) {
  const { buildBucketsRows } = require("../src/lib/sync-store/exporter");
  const localRows = buildBucketsRows({
    queuePath: path.join(device.trackerDir, "queue.jsonl"),
    machineId: device.machineId,
  });
  const importsDir = path.join(device.trackerDir, "webdav", "imports");
  let remoteDevices = [];
  try {
    const entries = await fs.readdir(importsDir);
    remoteDevices = [];
    for (const machineId of entries) {
      const store = createDeviceImportStore({ importsDir, machineId });
      const rows = await store.readMergedBuckets();
      if (rows.length > 0) remoteDevices.push({ machineId, rows });
    }
  } catch { /* no imports yet */ }
  return mergeBucketsAcrossDevices({ localRows, remoteDevices });
}

function bucket(source, model, hour, total, extra = {}) {
  return {
    source, model, hour_start: hour,
    input_tokens: total, output_tokens: 0, cached_input_tokens: 0,
    cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
    total_tokens: total, total_cost_usd: 0, conversation_count: 1,
    ...extra,
  };
}

test("two devices converge on identical all-device views without double counting", async () => {
  await withTwoDevices(async ({ deviceA, deviceB, harness }) => {
    // Device A (Mac) collects Codex usage; device B (Windows) collects ZCode.
    await appendQueue(deviceA.trackerDir, [
      bucket("codex", "gpt-5.4", "2026-10-25T14:00:00.000Z", 1000),
    ]);
    await appendQueue(deviceB.trackerDir, [
      bucket("zcode", "glm-5", "2026-10-25T14:00:00.000Z", 500),
    ]);

    let stateA = { version: 1, docs: {}, imported: {} };
    let stateB = { version: 1, docs: {}, imported: {} };
    let resultA = await cycle(deviceA, stateA);
    stateA = resultA.state;
    assert.equal(resultA.ok, true, JSON.stringify(resultA));
    let resultB = await cycle(deviceB, stateB);
    stateB = resultB.state;
    assert.equal(resultB.ok, true);

    // Second round so each device imports the other's data.
    resultA = await cycle(deviceA, stateA);
    stateA = resultA.state;
    resultB = await cycle(deviceB, stateB);
    stateB = resultB.state;

    const viewA = await mergedViewFor(deviceA);
    const viewB = await mergedViewFor(deviceB);
    assert.equal(viewA.length, 2);
    assert.equal(viewB.length, 2);
    const totalA = viewA.reduce((acc, row) => acc + row.total_tokens, 0);
    const totalB = viewB.reduce((acc, row) => acc + row.total_tokens, 0);
    assert.equal(totalA, 1500);
    assert.equal(totalB, 1500);

    // Repeated cycles with no new data must not change totals and must not
    // re-upload (content-hash change detection).
    const uploadsBefore = harness.state.requests.filter((r) => r.method === "PUT").length;
    resultA = await cycle(deviceA, stateA);
    stateA = resultA.state;
    resultB = await cycle(deviceB, stateB);
    stateB = resultB.state;
    const uploadsAfter = harness.state.requests.filter((r) => r.method === "PUT").length;
    assert.equal(uploadsAfter - uploadsBefore, 0, "unchanged data and device metadata produce no uploads");
    const viewA2 = await mergedViewFor(deviceA);
    assert.equal(viewA2.reduce((acc, row) => acc + row.total_tokens, 0), 1500);

    // New usage on A flows to B on the next cycle pair.
    await appendQueue(deviceA.trackerDir, [
      bucket("codex", "gpt-5.4", "2026-10-25T14:30:00.000Z", 700),
    ]);
    resultA = await cycle(deviceA, stateA);
    stateA = resultA.state;
    resultB = await cycle(deviceB, stateB);
    stateB = resultB.state;
    const viewB2 = await mergedViewFor(deviceB);
    assert.equal(viewB2.reduce((acc, row) => acc + row.total_tokens, 0), 2200);
  });
});

test("account-level cursor usage from two machines counts once on both", async () => {
  await withTwoDevices(async ({ deviceA, deviceB, harness }) => {
    // Same vendor account measured from both machines — MAX, not sum.
    await appendQueue(deviceA.trackerDir, [
      bucket("cursor", "cursor-agent", "2026-10-25T10:00:00.000Z", 1000, { updated_at: "2026-10-25T10:10:00.000Z", device_id: "machine-a" }),
    ]);
    await appendQueue(deviceB.trackerDir, [
      bucket("cursor", "cursor-agent", "2026-10-25T10:00:00.000Z", 1300, { updated_at: "2026-10-25T10:20:00.000Z", device_id: "machine-b" }),
    ]);

    let stateA = { version: 1, docs: {}, imported: {} };
    let stateB = { version: 1, docs: {}, imported: {} };
    let resultA = await cycle(deviceA, stateA); stateA = resultA.state;
    let resultB = await cycle(deviceB, stateB); stateB = resultB.state;
    resultA = await cycle(deviceA, stateA); stateA = resultA.state;
    resultB = await cycle(deviceB, stateB); stateB = resultB.state;

    const viewA = await mergedViewFor(deviceA);
    const viewB = await mergedViewFor(deviceB);
    const cursorA = viewA.find((row) => row.source === "cursor");
    const cursorB = viewB.find((row) => row.source === "cursor");
    assert.equal(cursorA.total_tokens, 1300, "canonical row is the higher observation");
    assert.equal(cursorB.total_tokens, 1300);
  });
});

test("revised buckets replace the old value instead of accumulating", async () => {
  await withTwoDevices(async ({ deviceA, deviceB, harness }) => {
    await appendQueue(deviceA.trackerDir, [
      bucket("codex", "gpt-5.4", "2026-10-25T14:00:00.000Z", 1000),
    ]);
    let stateB = { version: 1, docs: {}, imported: {} };
    let stateA = { version: 1, docs: {}, imported: {} };
    let resultA = await cycle(deviceA, stateA); stateA = resultA.state;
    let resultB = await cycle(deviceB, stateB); stateB = resultB.state;

    // A's own revision (downward correction) must propagate as replacement.
    const queuePath = path.join(deviceA.trackerDir, "queue.jsonl");
    const raw = await fs.readFile(queuePath, "utf8");
    const corrected = bucket("codex", "gpt-5.4", "2026-10-25T14:00:00.000Z", 400);
    await fs.writeFile(queuePath, raw + JSON.stringify(corrected) + "\n", "utf8");

    resultA = await cycle(deviceA, stateA); stateA = resultA.state;
    resultB = await cycle(deviceB, stateB); stateB = resultB.state;
    const viewB = await mergedViewFor(deviceB);
    const row = viewB.find((r) => r.source === "codex");
    assert.equal(row.total_tokens, 400, "downward correction replaces, not sums");
  });
});

test("device restore with stale local state re-bases instead of regressing", async () => {
  await withTwoDevices(async ({ deviceA, deviceB, harness }) => {
    await appendQueue(deviceA.trackerDir, [
      bucket("codex", "gpt-5.4", "2026-10-25T14:00:00.000Z", 1000),
    ]);
    let stateA = { version: 1, docs: {}, imported: {} };
    let resultA = await cycle(deviceA, stateA); stateA = resultA.state;

    // Device restore: local sync state lost. The next export must not reuse
    // sequence 1 (it takes server max + 1) and must not corrupt imports.
    const stateRestored = { version: 1, docs: {}, imported: {} };
    resultA = await cycle(deviceA, stateRestored);
    stateA = resultA.state;
    assert.ok(stateA.docs.buckets.seq >= 2, `expected seq >= 2 after restore, got ${stateA.docs.buckets.seq}`);

    let stateB = { version: 1, docs: {}, imported: {} };
    let resultB = await cycle(deviceB, stateB); stateB = resultB.state;
    resultB = await cycle(deviceB, stateB); stateB = resultB.state;
    const viewB = await mergedViewFor(deviceB);
    const row = viewB.find((r) => r.source === "codex");
    assert.equal(row.total_tokens, 1000);
  });
});

test("https enforcement: non-local http config is rejected", async () => {
  const result = await runSyncCycle({
    config: { url: "http://dav.example.com", username: "u", directory: "x", enabled: true },
    password: "p",
    machineId: "m",
    trackerDir: "/tmp/unused",
    state: { version: 1, docs: {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_CONFIG");
});
