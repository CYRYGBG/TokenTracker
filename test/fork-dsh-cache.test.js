const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const rollout = require("../src/lib/rollout");
const { scanDshSessions } = require("../src/lib/fork-dsh-sessions");
test("DSH cache skips unchanged decoding, invalidates revisions and never retains content", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-dsh-cache-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const folder = path.join(home, ".dsh/sessions/project/session-1");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "session.jsonl"), cacheFile = path.join(home, "cache.json");
  const make = (output) => [
    { type: "session", id: "session-1" },
    { type: "assistant/message", seq: 1, time: Date.parse("2026-10-25T10:00:00Z"), data: {
      message: { source: { model: "deepseek/deepseek-v4-flash" }, content: "NEVER_RETAIN_PRIVATE_CONTENT" },
      usage: { inputTokens: 10, outputTokens: output },
    } },
  ].map(JSON.stringify).join("\n") + "\n";
  await fs.writeFile(file, make(5));
  let reads = 0;
  const original = rollout.readDshSessionText;
  t.mock.method(rollout, "readDshSessionText", async (...args) => { reads++; return original(...args); });
  const first = await scanDshSessions(home, { cacheFile });
  const before = await fs.stat(cacheFile, { bigint: true });
  const second = await scanDshSessions(home, { cacheFile });
  assert.deepEqual(second, first); assert.equal(reads, 1);
  assert.equal((await fs.stat(cacheFile, { bigint: true })).mtimeNs, before.mtimeNs);
  assert.equal((await fs.readFile(cacheFile, "utf8")).includes("NEVER_RETAIN"), false);
  await fs.writeFile(file, make(7)); // same length; file metadata must still invalidate
  assert.equal((await scanDshSessions(home, { cacheFile }))[0].total_tokens, 17);
  assert.equal(reads, 2);
  await scanDshSessions(home, { cacheFile, force: true }); assert.equal(reads, 3);
  await fs.rm(file); assert.deepEqual(await scanDshSessions(home, { cacheFile }), []);
});
