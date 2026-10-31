// HANDOFF-1.5.0 §1 integration coverage: when a readable Codex source is
// rescanned with revised usage (e.g. after the ledger-consistency fix), the
// revision is written back to the fork's long-term history and leaves as a
// whole-row downward revision; a session whose source is deleted keeps its
// history instead of being recomputed away.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { runSyncCycle } = require("../src/lib/webdav/scheduler");
const { parseDocument } = require("../src/lib/sync-store/format");
const durable = require("../src/lib/fork-store");
const { createWebDavTestServer } = require("./helpers/webdav-server");

const usage = (n) => ({ input_tokens: n, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: n });
const record = (ms, last, total) => ({
  timestamp: new Date(Date.UTC(2026, 6, 2, 0, 0, 0, ms)).toISOString(),
  type: "event_msg",
  payload: { type: "token_count", info: { last_token_usage: usage(last), total_token_usage: usage(total) } },
});
async function writeRollout(home, id, total) {
  const file = path.join(home, ".codex/sessions/2026/07/02", `rollout-2026-07-02T00-00-00-${id}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const records = [
    { timestamp: "2026-07-02T00:00:00.000Z", type: "session_meta", payload: { id } },
    context(1, "model-a"),
    record(2, total, total),
  ];
  await fs.writeFile(file, records.map((x) => JSON.stringify(x) + "\n").join(""));
  return file;
}
function context(ms, model) {
  return {
    timestamp: new Date(Date.UTC(2026, 6, 2, 0, 0, 0, ms)).toISOString(),
    type: "turn_context",
    payload: { model, current_date: "2026-07-02" },
  };
}

test("a Codex usage revision rewrites fork history and syncs as a downward whole-row revision; a deleted source keeps its history", async () => {
  const harness = createWebDavTestServer();
  await harness.listen();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-revision-"));
    try {
      // The scheduler derives the scanned home as trackerDir's grandparent,
      // mirroring the production ~/.tokentracker-personal/tracker layout.
      const home = path.join(root, "home");
      const tracker = path.join(home, ".tokentracker-personal", "tracker");
    await fs.mkdir(tracker, { recursive: true });
    const idA = "11111111-1111-4111-8111-111111111111";
    const idB = "22222222-2222-4222-8222-222222222222";
    await writeRollout(home, idA, 100);
    await writeRollout(home, idB, 70);

    const config = { url: harness.baseUrl(), username: "user", directory: "tokentracker-fork", enabled: true };
    const device = { trackerDir: tracker, machineId: "machine-a", password: "app-password", config };
    const cycle = (state) =>
      runSyncCycle({ config: device.config, password: device.password, machineId: device.machineId, trackerDir: device.trackerDir, state });

    let state = { version: 1, docs: {}, imported: {} };
    state = (await cycle(state)).state;
    const sessionsFile = path.join(tracker, "fork-history", "sessions.json");
    const first = await durable.read(sessionsFile, []);
    const byHash = Object.fromEntries(first.map((row) => [row.session_id, row]));
    assert.equal(byHash[idA].total_tokens, 100);
    assert.equal(byHash[idB].total_tokens, 70);

    // The source is rescanned with revised (lower) usage; another source is
    // deleted before the rescan. The sidecar's 5-minute TTL would serve the
    // previous scan, so force one refresh exactly like a manual refresh does.
    await writeRollout(home, idA, 40);
    await fs.rm(path.join(home, ".codex/sessions/2026/07/02", `rollout-2026-07-02T00-00-00-${idB}.jsonl`));
    await require("../src/lib/fork-view").collectSessions(tracker, { home, force: true });
    state = (await cycle(state)).state;

    const revised = await durable.read(sessionsFile, []);
    const revisedByHash = Object.fromEntries(revised.map((row) => [row.session_id, row]));
    assert.equal(revisedByHash[idA].total_tokens, 40, "the revision is written back to long-term history");
    assert.equal(revisedByHash[idB].total_tokens, 70, "a deleted source keeps its recorded history");
    const revisedRow = revisedByHash[idA];
    assert.equal(revisedRow.fork_frozen_cost_usd, revisedRow.cost_usd, "usage revision refreezes the estimate on the new usage");

    // The sync export sends exactly the revised row downward.
    const segName = [...harness.state.files.keys()]
      .map((p) => path.basename(p))
      .filter((n) => n.startsWith("sessions-seg-"))
      .sort()
      .at(-1);
    assert.ok(segName, "the revision leaves as a segment");
    const seg = parseDocument(harness.state.files.get(`/tokentracker-fork/devices/machine-a/${segName}`));
    assert.equal(seg.header.rows, 1, `segment carries only the revised row, got ${seg.header.rows}`);
    assert.equal(seg.rows[0].session_id, idA);
    assert.equal(seg.rows[0].total_tokens, 40, "the whole row travels downward, not a delta number");

    // A later unchanged cycle re-sends nothing.
    const namesBefore = [...harness.state.files.keys()].filter((p) => p.includes("sessions-")).sort().join(",");
    state = (await cycle(state)).state;
    const namesAfter = [...harness.state.files.keys()].filter((p) => p.includes("sessions-")).sort().join(",");
    assert.equal(namesAfter, namesBefore);
  } finally {
    await harness.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
