// Retry scheduling for HANDOFF-1.5.0 §6: a failure retry fires near the
// backoff expiry, independent of the configured sync interval (30 minutes or
// 24 hours), Retry-After is honored, auth failures pause automatic retries
// while manual sync still works, and a restarted process resumes the pending
// retry from persisted state.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createWebdavScheduler } = require("../src/lib/webdav/scheduler");
const { createWebDavTestServer } = require("./helpers/webdav-server");

async function withHarness(run, { intervalMinutes = 30 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-retry-sched-"));
  const dav = createWebDavTestServer();
  await dav.listen();
  let failExport = false;
  const fetchCalls = [];
  const scheduler = createWebdavScheduler({
    trackerDir: dir,
    getConfig: async () => ({ url: dav.baseUrl(), username: "user", enabled: true, interval_minutes: intervalMinutes }),
    loadPassword: async () => "app-password",
    machineIdProvider: async () => "fixture-mac",
    fetchImpl: async (url, init) => {
      fetchCalls.push({ method: init?.method, path: String(url) });
      if (failExport && ["MKCOL", "PUT"].includes(init?.method)) {
        const e = new Error("boom");
        e.name = "TimeoutError";
        throw e;
      }
      return fetch(url, init);
    },
  });
  const statePath = path.join(dir, "webdav", "state.json");
  try {
    await run({ scheduler, dav, statePath, fetchCalls, setFail: (v) => { failExport = v; } });
  } finally {
    scheduler.stop();
    await dav.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function readState(statePath) {
  return JSON.parse(await fs.readFile(statePath, "utf8"));
}
async function writeState(statePath, state) {
  await fs.writeFile(statePath, JSON.stringify(state));
}

test("a 30-minute interval with a failed export retries near the 1-minute backoff, not at the next interval", async () => {
  await withHarness(async ({ scheduler, statePath, setFail }) => {
    assert.equal((await scheduler.syncNow()).ok, true);
    setFail(true);
    assert.equal((await scheduler.syncNow()).ok, false);
    const failed = await readState(statePath);
    const waitMs = failed.next_attempt_ms - Date.now();
    assert.ok(waitMs > 30_000 && waitMs <= 60_000, `first backoff should be ~1 minute, got ${waitMs}ms`);
    // Before expiry the automatic cycle is skipped.
    assert.equal((await scheduler.cycle()).skipped, "backoff");
    // A 30-minute interval gate must not extend the wait: once the backoff
    // expires (virtual clock: rewrite the persisted timestamp), the next
    // automatic cycle runs immediately.
    failed.next_attempt_ms = Date.now() - 1;
    await writeState(statePath, failed);
    const retried = await scheduler.cycle();
    assert.notEqual(retried.skipped, "backoff");
    assert.notEqual(retried.skipped, "interval");
  });
});

test("a 24-hour interval does not delay backoff retries and success restores the normal cadence", async () => {
  await withHarness(async ({ scheduler, statePath, setFail, fetchCalls }) => {
    assert.equal((await scheduler.syncNow()).ok, true);
    setFail(true);
    assert.equal((await scheduler.syncNow()).ok, false);
    let state = await readState(statePath);
    state.next_attempt_ms = Date.now() - 1;
    await writeState(statePath, state);
    const attemptsBefore = fetchCalls.length;
    assert.equal((await scheduler.cycle({ manual: false })).ok, false, "the retry attempts despite the 24h interval");
    assert.ok(fetchCalls.length > attemptsBefore, "network was touched for the retry");
    // Success clears the pending retry; the next automatic cycle waits for
    // the full interval again.
    setFail(false);
    assert.equal((await scheduler.syncNow()).ok, true);
    state = await readState(statePath);
    assert.equal(state.next_attempt_ms, undefined, "pending retry cleared on success");
    assert.equal((await scheduler.cycle()).skipped, "interval");
  });
});

test("subsequent failures climb the 5/15/60 minute backoff ladder", async () => {
  await withHarness(async ({ scheduler, statePath, setFail }) => {
    assert.equal((await scheduler.syncNow()).ok, true);
    setFail(true);
    await scheduler.syncNow();
    const first = await readState(statePath);
    assert.ok(first.next_attempt_ms - Date.now() > 30_000, "step 1 ≈ 1 minute");
    // Each expired retry that fails again advances one step.
    for (const [step, expected] of [[2, 5 * 60_000], [3, 15 * 60_000], [4, 60 * 60_000], [5, 60 * 60_000]]) {
      const state = await readState(statePath);
      state.next_attempt_ms = Date.now() - 1;
      await writeState(statePath, state);
      await scheduler.cycle();
      const now = await readState(statePath);
      const wait = now.next_attempt_ms - Date.now();
      assert.ok(
        wait > expected - 30_000 && wait <= expected,
        `step ${step} should back off ~${expected / 60_000} minutes, got ${Math.round(wait / 1000)}s`,
      );
      assert.equal(now.backoff_step, Math.min(step, 4), "backoff ladder caps at four steps");
    }
  });
});

test("Retry-After seconds are honored over the default ladder", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-retry-ra-"));
  const dav = createWebDavTestServer();
  await dav.listen();
  try {
    dav.state.faults.MKCOL = { status: 429, retryAfter: "90" };
    const scheduler = createWebdavScheduler({
      trackerDir: dir,
      getConfig: async () => ({ url: dav.baseUrl(), username: "user", enabled: true }),
      loadPassword: async () => "app-password",
      machineIdProvider: async () => "fixture-mac",
    });
    assert.equal((await scheduler.syncNow()).ok, false);
    const state = JSON.parse(await fs.readFile(path.join(dir, "webdav", "state.json"), "utf8"));
    const wait = state.next_attempt_ms - Date.now();
    assert.ok(wait > 60_000 && wait <= 90_000, `Retry-After 90s should be honored, got ${Math.round(wait / 1000)}s`);
    scheduler.stop();
  } finally {
    await dav.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("401 pauses automatic retries but manual sync still reaches the network", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-retry-auth-"));
  const dav = createWebDavTestServer();
  await dav.listen();
  try {
    dav.state.faults.PUT = { status: 401 };
    const scheduler = createWebdavScheduler({
      trackerDir: dir,
      getConfig: async () => ({ url: dav.baseUrl(), username: "user", enabled: true }),
      loadPassword: async () => "app-password",
      machineIdProvider: async () => "fixture-mac",
    });
    const failed = await scheduler.syncNow();
    assert.equal(failed.ok, false);
    let state = await readState(path.join(dir, "webdav", "state.json"));
    assert.equal(state.paused_auth, true);
    assert.equal(state.next_attempt_ms, undefined, "auth pause does not schedule a backoff retry");
    assert.equal((await scheduler.cycle()).skipped, "auth-paused");
    // Manual sync still attempts (and fails while the fault persists).
    const manual = await scheduler.syncNow();
    assert.equal(manual.ok, false);
    scheduler.stop();
  } finally {
    await dav.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a restarted process resumes a pending retry from persisted state without touching the network early", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-retry-restart-"));
  const dav = createWebDavTestServer();
  await dav.listen();
  try {
    await fs.mkdir(path.join(dir, "webdav"), { recursive: true });
    await writeState(path.join(dir, "webdav", "state.json"), {
      version: 1,
      docs: {},
      imported: {},
      last_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      next_attempt_ms: Date.now() + 60_000,
    });
    const scheduler = createWebdavScheduler({
      trackerDir: dir,
      getConfig: async () => ({ url: dav.baseUrl(), username: "user", enabled: true }),
      loadPassword: async () => "app-password",
      machineIdProvider: async () => "fixture-mac",
    });
    assert.equal((await scheduler.cycle()).skipped, "backoff", "the persisted backoff survives restart");
    // Expiring it lets the retry through on the restarted instance.
    const state = await readState(path.join(dir, "webdav", "state.json"));
    state.next_attempt_ms = Date.now() - 1;
    await writeState(path.join(dir, "webdav", "state.json"), state);
    assert.equal((await scheduler.cycle()).ok, true);
    scheduler.stop();
  } finally {
    await dav.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the scheduler timer wakes near the pending retry instead of the full interval", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-retry-timer-"));
  const dav = createWebDavTestServer();
  await dav.listen();
  try {
    await fs.mkdir(path.join(dir, "webdav"), { recursive: true });
    await writeState(path.join(dir, "webdav", "state.json"), {
      version: 1,
      docs: {},
      imported: {},
      last_attempt_at: new Date().toISOString(),
      next_attempt_ms: Date.now() + 5400,
    });
    const started = Date.now();
    const scheduler = createWebdavScheduler({
      trackerDir: dir,
      getConfig: async () => ({ url: dav.baseUrl(), username: "user", enabled: true, interval_minutes: 30 }),
      loadPassword: async () => "app-password",
      machineIdProvider: async () => "fixture-mac",
    });
    scheduler.start();
    // The first tick fires at 5s (initial timer) while the retry is still
    // pending; the tick then re-arms for the remaining ~400ms and the cycle
    // runs well before the 30-minute interval would allow.
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const state = await readState(path.join(dir, "webdav", "state.json"));
      if (state.last_success_at) {
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 10_000, `retry fired after ${elapsed}ms, not at the 30-minute interval`);
        scheduler.stop();
        return;
      }
    }
    throw new Error("the pending retry never fired");
  } finally {
    await dav.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a transient connection reset during upload retries once inside the cycle and still publishes", async () => {
  const harness = createWebDavTestServer();
  await harness.listen();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-retry-transient-"));
  try {
    await fs.writeFile(path.join(dir, "queue.jsonl"), "");
    const { WebDavClient } = require("../src/lib/webdav/client");
    const { runSyncCycle } = require("../src/lib/webdav/scheduler");
    let putAttempts = 0;
    const flakyFetch = async (url, init = {}) => {
      if (init.method === "PUT" && String(url).includes(".part") && putAttempts++ === 0) {
        const e = new Error("other side closed");
        e.code = "ECONNRESET";
        throw e;
      }
      return fetch(url, init);
    };
    const client = new WebDavClient({
      baseUrl: harness.baseUrl(),
      username: "user",
      password: "app-password",
      fetchImpl: flakyFetch,
    });
    const result = await runSyncCycle({
      config: { url: harness.baseUrl(), username: "user", directory: "tokentracker-fork", enabled: true },
      password: "app-password",
      machineId: "machine-a",
      trackerDir: dir,
      state: { version: 1, docs: {}, imported: {} },
      client,
    });
    assert.equal(result.ok, true, `cycle should recover via the in-cycle retry: ${JSON.stringify(result.notes)}`);
    assert.ok(putAttempts >= 2, `the failed part PUT must be retried (${putAttempts})`);
    assert.ok(result.state.notes.some((n) => n.includes("retrying once")), "the retry is recorded as a note");
    assert.ok([...harness.state.files.keys()].some((p) => p.includes("buckets-base-")), "the document still published");
  } finally {
    await harness.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
