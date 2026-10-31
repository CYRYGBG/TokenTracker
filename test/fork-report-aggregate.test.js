// /api/fork/report must produce exactly what the six individual endpoints
// produce for the same inputs — from ONE shared history load instead of six
// independent full-parse chains (HANDOFF-1.5.0 §4).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createLocalApiHandler } = require("../src/lib/local-api");
const exporter = require("../src/lib/sync-store/exporter");
const { createDeviceImportStore } = require("../src/lib/sync-store/importer");
const { serializeDocument, parseDocument } = require("../src/lib/sync-store/format");

async function withServer(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-fork-report-"));
  const originalBuild = exporter.buildBucketsRows;
  let bucketLoads = 0;
  exporter.buildBucketsRows = (...args) => {
    bucketLoads++;
    return originalBuild(...args);
  };
  const handler = createLocalApiHandler({
    queuePath: path.join(dir, "queue.jsonl"),
    trackerDataDir: dir,
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    handler(req, res, url).catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error && error.message) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(base + "/api/local-auth")).json();
  try {
    await run({ dir, base, token, loads: () => bucketLoads, resetLoads: () => { bucketLoads = 0; } });
  } finally {
    exporter.buildBucketsRows = originalBuild;
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function get(base, p, token) {
  const r = await fetch(base + p, { headers: { "x-tokentracker-local-auth": token, Origin: base } });
  assert.ok(r.ok, `${p} -> ${r.status}`);
  return r.json();
}
function bucketRow(source, model, hour, total) {
  return {
    source, model, hour_start: hour,
    input_tokens: total, output_tokens: 0, cached_input_tokens: 0,
    cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
    total_tokens: total, billable_total_tokens: total, conversation_count: 1,
  };
}

test("report aggregate matches the six individual endpoints exactly", async () => {
  await withServer(async ({ dir, base, token }) => {
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ machineId: "machine-local" }));
    await fs.writeFile(path.join(dir, "queue.jsonl"), [
      bucketRow("codex", "gpt-5.4", "2026-10-25T14:00:00.000Z", 100),
      bucketRow("codex", "gpt-5.4", "2026-10-26T09:30:00.000Z", 30),
      bucketRow("zcode", "glm-5", "2026-10-25T15:00:00.000Z", 20),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const importsDir = path.join(dir, "webdav", "imports");
    const store = createDeviceImportStore({ importsDir, machineId: "machine-remote" });
    await store.saveDeviceInfo({ name: "machine-remote", platform: "win32", updated_at: "2026-10-26T00:00:00Z" });
    await store.applyDocument(parseDocument(serializeDocument({
      kind: "buckets", device: "machine-remote", seq: 1,
      rows: [bucketRow("codex", "gpt-5.4", "2026-10-25T16:00:00.000Z", 200)],
    })));
    // A project row so the project panel has attributed data.
    await fs.writeFile(path.join(dir, "project.queue.jsonl"), [
      { project_key: "owner/repo", source: "codex", hour_start: "2026-10-25T14:00:00.000Z", total_tokens: 60, billable_total_tokens: 60 },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");

    const params = "from=2026-10-25&to=2026-10-26&previous_from=2026-10-24&previous_to=2026-10-24&device_id=all";
    const report = await get(base, `/api/fork/report?${params}`, token);
    const [summaryCurrent, summaryPrevious, daily, breakdown, projects, devices] = await Promise.all([
      get(base, `/functions/tokentracker-usage-summary?from=2026-10-25&to=2026-10-26&device_id=all`, token),
      get(base, `/functions/tokentracker-usage-summary?from=2026-10-24&to=2026-10-24&device_id=all`, token),
      get(base, `/functions/tokentracker-usage-daily?from=2026-10-25&to=2026-10-26&device_id=all`, token),
      get(base, `/functions/tokentracker-usage-model-breakdown?from=2026-10-25&to=2026-10-26&device_id=all`, token),
      get(base, `/functions/tokentracker-project-usage-summary?from=2026-10-25&to=2026-10-26&device_id=all`, token),
      get(base, `/api/fork/device-usage?from=2026-10-25&to=2026-10-26`, token),
    ]);
    const strip = (value) => JSON.parse(JSON.stringify(value, (k, v) => (k === "generated_at" ? undefined : v)));
    assert.deepEqual(strip(report.summary), strip(summaryCurrent));
    assert.deepEqual(strip(report.previous), strip(summaryPrevious));
    assert.deepEqual(strip(report.daily), strip(daily));
    assert.deepEqual(strip(report.breakdown), strip(breakdown));
    assert.deepEqual(strip(report.projects), strip(projects));
    assert.deepEqual(strip(report.devices), strip(devices));
    assert.equal(report.summary.totals.total_tokens, 350, "all-device merge feeds the report (100+30+20+200)");
  });
});

test("one report request performs a single bucket parse chain; the old six-request refresh performed several", async () => {
  await withServer(async ({ dir, base, token, loads, resetLoads }) => {
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ machineId: "machine-local" }));
    await fs.writeFile(path.join(dir, "queue.jsonl"), [
      bucketRow("codex", "gpt-5.4", "2026-10-25T14:00:00.000Z", 100),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const importsDir = path.join(dir, "webdav", "imports");
    const store = createDeviceImportStore({ importsDir, machineId: "machine-remote" });
    await store.saveDeviceInfo({ name: "machine-remote", platform: "win32", updated_at: "2026-10-26T00:00:00Z" });
    await store.applyDocument(parseDocument(serializeDocument({
      kind: "buckets", device: "machine-remote", seq: 1,
      rows: [bucketRow("codex", "gpt-5.4", "2026-10-25T16:00:00.000Z", 200)],
    })));
    const params = "from=2026-10-25&to=2026-10-26&previous_from=2026-10-24&previous_to=2026-10-24&device_id=all";

    // The old dashboard refresh, measured with sequential requests so the
    // in-flight coalescing cannot merge them: each one re-parses the history.
    resetLoads();
    for (const p of [
      `/functions/tokentracker-usage-summary?from=2026-10-25&to=2026-10-26&device_id=all`,
      `/functions/tokentracker-usage-summary?from=2026-10-24&to=2026-10-24&device_id=all`,
      `/functions/tokentracker-usage-daily?from=2026-10-25&to=2026-10-26&device_id=all`,
      `/functions/tokentracker-usage-model-breakdown?from=2026-10-25&to=2026-10-26&device_id=all`,
      `/functions/tokentracker-project-usage-summary?from=2026-10-25&to=2026-10-26&device_id=all`,
      `/api/fork/device-usage?from=2026-10-25&to=2026-10-26`,
    ]) await get(base, p, token);
    const oldLoads = loads();
    assert.ok(oldLoads >= 5, `the six-request refresh parses the bucket history repeatedly (${oldLoads})`);

    // The aggregate request.
    resetLoads();
    await get(base, `/api/fork/report?${params}`, token);
    const newLoads = loads();
    assert.ok(newLoads <= 2, `one report request must not re-parse the history per payload (${newLoads})`);
  });
});

test("concurrent bucket reads coalesce onto one in-flight pass and stay correct", async () => {
  const view = require("../src/lib/fork-view");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-fork-snapshot-"));
  const originalBuild = exporter.buildBucketsRows;
  let loads = 0;
  try {
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ machineId: "machine-local" }));
    await fs.writeFile(path.join(dir, "queue.jsonl"), [
      bucketRow("codex", "gpt-5.4", "2026-10-25T14:00:00.000Z", 100),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    exporter.buildBucketsRows = (...args) => {
      loads++;
      // A slow read gives a second caller the chance to join the in-flight pass.
      return new Promise((resolve) => setTimeout(() => resolve(originalBuild(...args)), 25));
    };
    const url = { searchParams: new URLSearchParams({ device_id: "all" }) };
    const [a, b] = await Promise.all([view.buckets(dir, url), view.buckets(dir, url)]);
    assert.equal(loads, 1, `concurrent readers share one pass (${loads})`);
    assert.equal(a.reduce((s, r) => s + r.total_tokens, 0), 100);
    assert.equal(b.reduce((s, r) => s + r.total_tokens, 0), 100);
    // A later read after the pass settled sees fresh content.
    await fs.appendFile(path.join(dir, "queue.jsonl"), JSON.stringify(bucketRow("codex", "gpt-5.4", "2026-10-25T15:00:00.000Z", 50)) + "\n");
    const next = await view.buckets(dir, url);
    assert.equal(next.reduce((s, r) => s + r.total_tokens, 0), 150, "no stale snapshot after coalescing");
  } finally {
    exporter.buildBucketsRows = originalBuild;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("report reflects data, device and pricing-basis changes immediately", async () => {
  await withServer(async ({ dir, base, token }) => {
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ machineId: "machine-local" }));
    await fs.writeFile(path.join(dir, "queue.jsonl"), [
      bucketRow("codex", "gpt-5.4", "2026-10-25T14:00:00.000Z", 100),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const params = "from=2026-10-25&to=2026-10-26&previous_from=2026-10-24&previous_to=2026-10-24&device_id=all";
    const before = await get(base, `/api/fork/report?${params}`, token);
    assert.equal(before.summary.totals.total_tokens, 100);

    // Same-size rewrite with different content must not be served stale.
    const sameSize = bucketRow("codex", "gpt-5.4", "2026-10-25T14:00:00.000Z", 101);
    await fs.writeFile(path.join(dir, "queue.jsonl"), JSON.stringify(sameSize) + "\n");
    const after = await get(base, `/api/fork/report?${params}`, token);
    assert.equal(after.summary.totals.total_tokens, 101, "same-size rewrite is visible");

    // A newly imported device appears in the device breakdown.
    const importsDir = path.join(dir, "webdav", "imports");
    const store = createDeviceImportStore({ importsDir, machineId: "machine-remote" });
    await store.saveDeviceInfo({ name: "machine-remote", platform: "win32", updated_at: "2026-10-26T00:00:00Z" });
    await store.applyDocument(parseDocument(serializeDocument({
      kind: "buckets", device: "machine-remote", seq: 1,
      rows: [bucketRow("codex", "gpt-5.4", "2026-10-25T16:00:00.000Z", 200)],
    })));
    const withRemote = await get(base, `/api/fork/report?${params}`, token);
    assert.equal(withRemote.summary.totals.total_tokens, 301, "imported device joins the all-device merge");
    assert.ok(withRemote.devices.devices.some((d) => d.id === "machine-remote"));
    // Row content survives identically through both paths (hash equality).
    const breakdown = await get(base, `/functions/tokentracker-usage-model-breakdown?from=2026-10-25&to=2026-10-26&device_id=all`, token);
    assert.deepEqual(withRemote.breakdown, breakdown);
  });
});
