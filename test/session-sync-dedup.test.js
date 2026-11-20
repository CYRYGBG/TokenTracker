// session-sync anti-double-count regression (docs/fork/SYNC_DESIGN.md §12.4).
// The core contract: a conversation imported from another device must not be
// re-counted by the local usage scanner, while appends that happen locally
// AFTER the import must count exactly once. Drives the real Codex incremental
// parser end-to-end through the adapter's export/import path.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { parseRolloutIncremental } = require("../src/lib/rollout");
const codexAdapter = require("../src/lib/session-sync/adapters/codex");

const DAY = "2026-11-14";
const CODEX_SESSION_ID = "01a1d7d5-eb1c-7e70-92db-34aad737c4b5";
const CODEX_RELATIVE_KEY = `sessions/2026/11/14/rollout-2026-11-14T10-14-43-${CODEX_SESSION_ID}.jsonl`;

const usage = (n) => ({
  input_tokens: n,
  cached_input_tokens: Math.floor(n / 2),
  cache_creation_input_tokens: 0,
  output_tokens: Math.floor(n / 10),
  total_tokens: n + Math.floor(n / 10),
});
const sessionMeta = () => ({
  timestamp: `${DAY}T10:00:00.000Z`,
  type: "session_meta",
  payload: { session_id: CODEX_SESSION_ID, id: CODEX_SESSION_ID, cwd: "/w/demo", originator: "codex_cli", model_provider: "openai" },
});
const tokenEvent = (last, total, second) => ({
  timestamp: `${DAY}T10:00:${String(second).padStart(2, "0")}.000Z`,
  type: "event_msg",
  payload: { type: "token_count", info: { last_token_usage: usage(last), total_token_usage: usage(total) } },
});
const line = (record) => JSON.stringify(record) + "\n";

async function queueRows(queuePath) {
  try {
    const raw = (await fs.readFile(queuePath, "utf8")).trim();
    if (!raw) return [];
    return raw.split("\n").map((row) => JSON.parse(row));
  } catch {
    return [];
  }
}

// queue.jsonl is append-only with last-row-wins per (source, model, hour).
function latestByModel(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.model, row);
  return map;
}

test("session-sync dedup: imported codex prefix counts zero; local append counts once; idempotent rescans", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-ss-dedup-"));
  try {
    const homeA = path.join(dir, "homeA");
    const homeB = path.join(dir, "homeB");
    const trackerA = path.join(dir, "trackerA");
    const trackerB = path.join(dir, "trackerB");
    const queueA = path.join(dir, "queueA.jsonl");
    const queueB = path.join(dir, "queueB.jsonl");

    // Device A: a conversation with two counted turns (100 + 50 = 150 total).
    const pathA = path.join(homeA, ".codex", CODEX_RELATIVE_KEY);
    await fs.mkdir(path.dirname(pathA), { recursive: true });
    const contentA = [
      sessionMeta(),
      tokenEvent(100, 100, 1),
      tokenEvent(50, 150, 2),
    ].map(line).join("");
    await fs.writeFile(pathA, contentA, "utf8");

    // A's scanner parses the file and produces a real cursor entry.
    const cursorsA = {};
    const resultA = await parseRolloutIncremental({ rolloutFiles: [pathA], cursors: cursorsA, queuePath: queueA });
    assert.ok(resultA.eventsAggregated >= 2);
    const rowsA = latestByModel(await queueRows(queueA));
    assert.equal(rowsA.get("unknown").total_tokens, usage(150).total_tokens, "A counted the full conversation");
    const cursorEntryA = cursorsA.files[pathA];
    assert.ok(cursorEntryA, "parser persisted a cursor for the file");
    assert.equal(cursorEntryA.offset, Buffer.byteLength(contentA));
    assert.ok(cursorEntryA.lastTotal, "cursor carries the usage snapshot");

    // Persist A's cursor state the way the scanner commits it, then export.
    await fs.mkdir(trackerA, { recursive: true });
    await fs.writeFile(path.join(trackerA, "cursors.json"), JSON.stringify({ files: cursorsA.files }), "utf8");
    const prepared = await codexAdapter.prepareUpload({ home: homeA, trackerDir: trackerA, sessionId: CODEX_SESSION_ID });
    assert.equal(prepared.files[0].buffer.toString("utf8"), contentA);

    // Device B imports the conversation.
    const backupsDir = path.join(trackerB, "backups");
    const importResult = await codexAdapter.importBundle({
      home: homeB, trackerDir: trackerB, files: prepared.files,
      meta: { session_id: CODEX_SESSION_ID, extra: { codexRelativePath: CODEX_RELATIVE_KEY }, cursor: prepared.meta.cursor },
      backupsDir, priorSha256: null,
    });
    const pathB = importResult.localPath;

    // B scan #1: the imported prefix must count for NOTHING on B.
    const cursorsB = JSON.parse(await fs.readFile(path.join(trackerB, "cursors.json"), "utf8"));
    const scan1 = await parseRolloutIncremental({ rolloutFiles: [pathB], cursors: cursorsB, queuePath: queueB });
    const rowsB1 = await queueRows(queueB);
    assert.equal(rowsB1.length, 0, "imported prefix must not be counted on the importing device");
    assert.equal(scan1.eventsAggregated, 0, "file fully skipped via the imported offset cursor");

    // B scan #2 immediately again: still nothing, and idempotent.
    await parseRolloutIncremental({ rolloutFiles: [pathB], cursors: cursorsB, queuePath: queueB });
    assert.equal((await queueRows(queueB)).length, 0, "second scan adds nothing (two consecutive scans do not double-count)");

    // B continues the conversation: one new turn worth 30 tokens.
    const appended = tokenEvent(30, 180, 3);
    await fs.appendFile(pathB, line(appended), "utf8");

    // B scan #3: exactly the delta is counted.
    await parseRolloutIncremental({ rolloutFiles: [pathB], cursors: cursorsB, queuePath: queueB });
    const rowsB3 = latestByModel(await queueRows(queueB));
    assert.equal(rowsB3.get("unknown").total_tokens, usage(30).total_tokens,
      "only the post-import append counts on B");

    // B scan #4: idempotent on the appended state.
    const stable = await fs.readFile(queueB, "utf8");
    const scan4 = await parseRolloutIncremental({ rolloutFiles: [pathB], cursors: cursorsB, queuePath: queueB });
    assert.equal(scan4.eventsAggregated, 0);
    assert.equal(await fs.readFile(queueB, "utf8"), stable, "no additional rows on rescan");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("session-sync dedup: zcode read filter drops exactly the imported message rows", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-ss-zc-dedup-"));
  try {
    const home = path.join(dir, "home");
    const tracker = path.join(dir, "tracker");
    const dbPath = path.join(home, ".zcode", "cli", "db", "db.sqlite");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });

    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, time_updated INTEGER, time_created INTEGER, type TEXT, data TEXT);
      CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT, model_id TEXT, status TEXT, started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER);
    `);
    db.prepare("INSERT INTO session_v2 VALUES ('s1', '/w', 't', 1)").run();
    for (let i = 1; i <= 4; i += 1) {
      db.prepare("INSERT INTO session_message VALUES (?, 's1', ?, ?, 'assistant', ?)")
        .run(`msg-${i}`, i, i, JSON.stringify({
          role: "assistant",
          providerID: "zcode",
          model: { id: "glm-5.3", providerID: "zcode" },
          tokens: { input: 10, output: 5 },
        }));
    }
    db.close();

    const { readZcodeDbMessages } = require("../src/lib/rollout");
    const all = readZcodeDbMessages(dbPath, { preferNode: true });
    assert.equal(all.length, 4, "fixture has four assistant messages");

    // Simulate the sync.js wrapper with msg-2 and msg-3 imported from afar.
    const { loadSessionSyncExcludedMessageIds } = require("../src/commands/sync");
    const store = require("../src/lib/session-sync/store");
    await store.appendImportedMessageIds(tracker, ["msg-2", "msg-3"]);
    const excluded = loadSessionSyncExcludedMessageIds(tracker);
    assert.equal(excluded.size, 2);
    const filtered = readZcodeDbMessages(dbPath, { preferNode: true })
      .filter((message) => !excluded.has(String(message?.id || "")));
    assert.deepEqual(filtered.map((m) => m.id).sort(), ["msg-1", "msg-4"],
      "exactly the imported rows drop, local rows survive");

    // A missing registry file means no filtering at all (feature unused).
    const emptyTracker = path.join(dir, "tracker-empty");
    assert.equal(loadSessionSyncExcludedMessageIds(emptyTracker).size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
