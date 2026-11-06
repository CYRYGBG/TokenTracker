const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseRolloutIncremental } = require("../src/lib/rollout");
const view = require("../src/lib/fork-view");
const { createDeviceImportStore } = require("../src/lib/sync-store/importer");
const { serializeDocument, parseDocument } = require("../src/lib/sync-store/format");

test("Codex model correction replaces frozen local and remote rows without log replay or duplicate totals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-model-upgrade-"));
  try {
    const tracker = path.join(root, "sender");
    const receiver = path.join(root, "receiver");
    await fs.mkdir(tracker, { recursive: true });
    await fs.mkdir(receiver, { recursive: true });
    const hour = "2026-10-05T10:00:00.000Z";
    const totals = n => ({ input_tokens: n, output_tokens: 0, cached_input_tokens: 0,
      cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: n,
      billable_total_tokens: n, conversation_count: 1 });
    const row = (model, n) => ({ source: "codex", model, hour_start: hour, ...totals(n) });
    const queuePath = path.join(tracker, "queue.jsonl");
    await fs.writeFile(queuePath, [row("gpt-6-astra", 100), row("gpt-6.1-sol", 250), row("unknown", 0)]
      .map(r => JSON.stringify(r) + "\n").join(""));
    const url = new URL("http://localhost/?device=all");
    const initial = await view.buckets(tracker, url);
    const machineId = require("../src/lib/machine-id").getOrCreateMachineId(queuePath);
    const store = createDeviceImportStore({ importsDir: path.join(receiver, "webdav", "imports"), machineId });
    const document = (seq, rows) => parseDocument(serializeDocument({ kind: "buckets", device: machineId,
      seq, sinceSeq: seq === 1 ? null : seq - 1, rows: rows.map(r => ({ ...r, device: machineId })) }));
    await store.applyDocument(document(1, initial));
    const cursors = { hourly: { version: 3, groupQueued: {}, buckets: Object.fromEntries(
      [["gpt-6-astra", 100], ["gpt-6.1-sol", 200], ["unknown", 50]]
        .map(([model, n]) => [`codex|${model}|${hour}`, { totals: totals(n), queuedKey: "old" }])) } };
    // No original logs: correction must use retained cursor totals alone.
    await parseRolloutIncremental({ rolloutFiles: [], cursors, queuePath });
    const corrected = await view.buckets(tracker, url);
    assert.deepEqual(Object.fromEntries(corrected.map(r => [r.model, r.total_tokens])),
      { "gpt-6-astra": 100, "gpt-6.1-sol": 200, unknown: 50 });
    assert.equal(corrected.reduce((n, r) => n + r.total_tokens, 0), 350);
    const unchanged = model => initial.find(r => r.model === model);
    assert.equal(corrected.find(r => r.model === "gpt-6-astra").fork_estimated_cost_usd,
      unchanged("gpt-6-astra").fork_estimated_cost_usd);
    const revision = document(2, corrected);
    await store.applyDocument(revision);
    assert.equal((await store.applyDocument(revision)).applied, false);
    const imported = await view.buckets(receiver, url);
    assert.deepEqual(imported.map(r => [r.model, r.total_tokens, r.fork_estimated_cost_usd]).sort(),
      corrected.map(r => [r.model, r.total_tokens, r.fork_estimated_cost_usd]).sort());
    const stable = await fs.readFile(queuePath, "utf8");
    assert.equal((await parseRolloutIncremental({ rolloutFiles: [], cursors: JSON.parse(JSON.stringify(cursors)), queuePath })).bucketsQueued, 0);
    assert.equal(await fs.readFile(queuePath, "utf8"), stable);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
