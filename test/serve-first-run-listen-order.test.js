const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

// Fork-adapted order assertions: the personal fork keeps its own first-run
// block before the listener, but the runtime refresh and the optional startup
// sync must not delay it (upstream #1055/#961 equivalent).
test("tracker serve binds before runtime refresh and startup sync", () => {
  const source = fs
    .readFileSync(path.join(repoRoot, "src/commands/serve.js"), "utf8")
    .replace(/\r\n/g, "\n");

  const listenIdx = source.indexOf("port = await listenOnAvailablePort");
  assert.ok(listenIdx > 0, "listener setup must exist");

  const refreshIdx = source.indexOf("await installLocalTrackerApp");
  assert.ok(refreshIdx > listenIdx, "runtime refresh must not delay the listener");

  const personalSkipIdx = source.indexOf(
    'if (process.env.TOKENTRACKER_PERSONAL !== "1") {\n    const { installLocalTrackerApp',
  );
  assert.ok(personalSkipIdx > 0, "personal mode must keep skipping the hook runtime refresh");
  assert.ok(personalSkipIdx > listenIdx, "personal skip must live in the post-listen refresh block");

  const syncIdx = source.indexOf("Syncing local data...");
  assert.ok(syncIdx > listenIdx, "startup sync must not delay the listener");

  const firstRunIdx = source.indexOf("First time? Setting up Token Tracker");
  assert.ok(firstRunIdx > 0, "first-run setup must exist");
  assert.ok(firstRunIdx < listenIdx, "fork keeps first-run setup before listen");
});
