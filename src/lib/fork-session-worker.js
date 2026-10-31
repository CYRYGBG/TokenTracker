// One bounded history build per tracker/home. The upstream scanners stay
// unchanged; the serve thread only reads their durable metadata result.
const path = require("node:path");
const os = require("node:os");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");

function buildInWorker(options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: options });
    let complete = false;
    worker.once("message", () => { complete = true; });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0 || !complete) reject(new Error("Session history worker did not complete"));
      else resolve();
    });
  });
}

function createSessionCollector(build = buildInWorker) {
  const builds = new Map();
  return function collect({ trackerDir, home = os.homedir(), force = false }) {
    const options = { trackerDir: path.resolve(trackerDir), home: path.resolve(home), force };
    const key = JSON.stringify([options.trackerDir, options.home]);
    const current = builds.get(key);
    if (current && (!force || current.force)) return current.promise;
    const run = () => build(options);
    const promise = current ? current.promise.then(run, run) : Promise.resolve().then(run);
    const entry = { promise, force: force || Boolean(current?.force) };
    builds.set(key, entry);
    const clear = () => { if (builds.get(key) === entry) builds.delete(key); };
    promise.then(clear, clear);
    return promise;
  };
}

const collectSessionHistory = createSessionCollector();
module.exports = { collectSessionHistory, createSessionCollector };

async function runWorker() {
  const fs = require("node:fs/promises");
  const { openLock } = require("./fs");
  const { trackerDir } = workerData;
  await fs.mkdir(trackerDir, { recursive: true });
  const deadline = performance.now() + 5 * 60_000;
  let lease;
  while (!(lease = await openLock(path.join(trackerDir, "history-build.lock"), { quietIfLocked: true }))) {
    if (performance.now() >= deadline) throw new Error("Session history build is busy");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  try {
    const pricing = require("./pricing");
    const candidates = [path.join(trackerDir, "pricing-cache.json"), path.join(path.dirname(trackerDir), "cache", "pricing.json")];
    const caches = await Promise.all(candidates.map(async (file) => ({ file, modified: await fs.stat(file).then((s) => s.mtimeMs, () => 0) })));
    caches.sort((a, b) => b.modified - a.modified);
    // Collection only reads the last saved price table; it never starts a
    // network refresh just because a new worker was created.
    await pricing.ensurePricingLoaded({ cachePath: caches[0].file, ttlMs: Infinity,
      fetchImpl: async () => { throw new Error("History uses saved pricing only"); } });
    const view = require("./fork-view");
    pricing.setCustomPrices((await view.preferences(trackerDir)).prices);
    await view.collectSessions(trackerDir, workerData);
  } finally { await lease.release(); }
}

if (!isMainThread && require.main === module && workerData?.trackerDir) {
  runWorker()
    .then(() => parentPort.postMessage({ complete: true }))
    .catch((error) => { throw error; });
}
