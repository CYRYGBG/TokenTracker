const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { test } = require("node:test");
const { createWebdavScheduler } = require("../src/lib/webdav/scheduler");
const { createWebDavTestServer } = require("./helpers/webdav-server");

test("automatic triggers share the selected interval across restarts; manual sync bypasses it", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-sync-cadence-"));
  const dav = createWebDavTestServer();
  await dav.listen();
  t.after(async () => { await dav.close(); await fs.rm(dir, { recursive: true, force: true }); });
  let interval = 60;
  const scheduler = createWebdavScheduler({
    trackerDir: dir,
    getConfig: async () => ({ url: dav.baseUrl(), username: "user", enabled: true, interval_minutes: interval }),
    loadPassword: async () => "app-password",
    machineIdProvider: async () => "fixture-mac",
  });
  t.after(() => scheduler.stop());
  assert.equal((await scheduler.cycle()).ok, true);
  const requests = dav.state.requests.length;
  await fs.writeFile(path.join(dir, "queue.jsonl"), "");
  assert.equal((await scheduler.cycle()).skipped, "interval");
  assert.equal(dav.state.requests.length, requests);
  assert.equal((await scheduler.syncNow()).ok, true);
  assert.ok(dav.state.requests.length > requests);
  const statePath = path.join(dir, "webdav/state.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.last_attempt_at = new Date(Date.now() - 10 * 60_000).toISOString();
  await fs.writeFile(statePath, JSON.stringify(state));
  assert.equal((await scheduler.cycle()).skipped, "interval");
  interval = 5;
  assert.equal((await scheduler.cycle()).ok, true);
  // A new process reads the same timestamp from disk; no timer reset can
  // bypass the user's cadence or the server's own backoff.
  const child = require("node:child_process").spawnSync(process.execPath, ["-e", `
    const {createWebdavScheduler}=require('./src/lib/webdav/scheduler');
    createWebdavScheduler({trackerDir:process.argv[1],getConfig:async()=>({url:'http://127.0.0.1:1',username:'user',interval_minutes:5}),loadPassword:async()=>{throw Error('must not connect')},machineIdProvider:async()=>'fixture-mac'}).cycle().then(r=>{if(r.skipped!=='interval')process.exitCode=1;});
  `, dir], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
});
