const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSessionCollector } = require("../src/lib/fork-session-worker");
test("history consumers share work; forced refresh chains behind ordinary work", async () => {
  const releases = [], calls = [];
  const collect = createSessionCollector((options) => {
    calls.push(options);
    return new Promise((resolve) => releases.push(resolve));
  });
  const options = { trackerDir: "/fixture/tracker", home: "/fixture" };
  const first = collect(options);
  assert.equal(collect(options), first);
  const forced = collect({ ...options, force: true });
  assert.equal(collect(options), forced);
  assert.equal(collect({ ...options, force: true }), forced);
  await Promise.resolve(); assert.equal(calls.length, 1);
  releases.shift()(); await first; await Promise.resolve();
  assert.equal(calls.length, 2); assert.equal(calls[1].force, true);
  releases.shift()(); await forced;
});
test("failed history builds can retry and separate homes do not share results", async () => {
  let calls = 0;
  const collect = createSessionCollector(async () => { if (++calls === 1) throw Error("fixture failure"); });
  const options = { trackerDir: "/fixture/tracker", home: "/fixture" };
  await assert.rejects(collect(options), /fixture failure/);
  await collect(options);
  await Promise.all([collect(options), collect({ ...options, home: "/different" })]);
  assert.equal(calls, 4);
});
test("real history workers retain custom prices, keep the main thread responsive and preserve deleted sources", async (t) => {
  const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-history-worker-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const tracker = path.join(home, ".tokentracker/tracker"), source = path.join(home, ".dsh/sessions/project/session-1");
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(tracker, { recursive: true });
  await fs.writeFile(path.join(source, "session.jsonl"), [
    { type: "session", id: "session-1" },
    { type: "assistant/message", seq: 1, time: Date.parse("2026-10-25T10:00:00Z"), data: {
      message: { source: { model: "deepseek/deepseek-v4-flash" } }, usage: { inputTokens: 10, outputTokens: 5 },
    } },
  ].map(JSON.stringify).join("\n") + "\n");
  await require("../src/lib/fork-prefs").append(tracker, "fixture-mac", { action: "custom_price_set", target: "dsh:deepseek-v4-flash",
    payload: { source: "dsh", model: "deepseek-v4-flash", input: 1000, output: 2000, cache_read: 0, cache_write: 0 } });
  let ticks = 0; const timer = setInterval(() => ticks++, 5); t.after(() => clearInterval(timer));
  const view = require("../src/lib/fork-view");
  const [first, concurrent] = await Promise.all([view.collectSessions(tracker, { home }), view.collectSessions(tracker, { home })]);
  assert.ok(ticks > 0); assert.deepEqual(concurrent, first); assert.equal(first[0].total_tokens, 15);
  assert.ok(Math.abs(first[0].cost_usd - 0.02) < 1e-9);
  assert.deepEqual(await view.collectSessions(tracker, { home }), first);
  await fs.rm(source, { recursive: true });
  assert.deepEqual(await view.collectSessions(tracker, { home }), first);
});

test("separate processes serialize history upserts without losing either source", async (t) => {
  const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
  const { execFile } = require("node:child_process"), { promisify } = require("node:util");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-history-processes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tracker = path.join(root, "tracker");
  const homes = await Promise.all(["a", "b"].map(async (id) => {
    const home = path.join(root, id), folder = path.join(home, ".dsh/sessions/project", id);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "session.jsonl"), [
      { type: "session", id }, { type: "assistant/message", seq: 1, time: Date.parse("2026-10-25T10:00:00Z"), data: {
        message: { source: { model: "deepseek/deepseek-v4-flash" } }, usage: { inputTokens: 10, outputTokens: 5 },
      } },
    ].map(JSON.stringify).join("\n") + "\n");
    return home;
  }));
  const module = require.resolve("../src/lib/fork-view");
  await Promise.all(homes.map((home) => promisify(execFile)(process.execPath, ["-e",
    `require(${JSON.stringify(module)}).collectSessions(process.argv[1], {home:process.argv[2],force:true}).catch(e=>{console.error(e);process.exitCode=1})`, tracker, home])));
  const result = JSON.parse(await fs.readFile(path.join(tracker, "fork-history/sessions.json"), "utf8"));
  assert.equal(result.length, 2); assert.equal(result.reduce((sum, row) => sum + row.total_tokens, 0), 30);
});
