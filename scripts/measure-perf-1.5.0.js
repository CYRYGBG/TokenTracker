#!/usr/bin/env node
// Re-runnable performance evidence for personal-v1.5.0 (HANDOFF-1.5.0 §7).
// Compares, on identical synthetic inputs:
//   1. no-source-change storage cycle   — bytes written (expect 0 on both)
//   2. single-row revision (>=10 MiB)   — old full-JSON rewrite vs journal delta
//   3. repeated small changes           — total bytes + compaction amortization
//   4. report refresh                   — bucket parse chains + wall time (6 requests vs 1)
//   5. two-device sync upload payload   — full-union seg (1.4.20 style) vs delta seg bytes
// Byte counts are fs write-call bytes (writeFile/appendFile payloads), not
// SSD wear; wall times are process-local. The 1.4.20 baseline modules are
// extracted from the git tag so both sides run in this same process.
"use strict";
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const repo = path.resolve(__dirname, "..");
const work = fssync.mkdtempSync(path.join(os.tmpdir(), "tt-perf-150-"));
const legacy = path.join(work, "legacy-lib");
const outDir = process.argv[2] || path.join(repo, "dist", "perf-1.5.0.noindex");
fssync.mkdirSync(legacy, { recursive: true });
fssync.mkdirSync(outDir, { recursive: true });
execFileSync("bash", ["-c", `git archive personal-v1.4.20 src/lib | tar -x -C '${legacy}'`], { cwd: repo, stdio: "ignore" });

// ---------------------------------------------------------------------------
// fs write-byte instrumentation (counts writeFile/appendFile payload bytes)
// ---------------------------------------------------------------------------
let writeBytes = 0;
const fsPromises = require("node:fs/promises");
const origWriteFile = fsPromises.writeFile.bind(fsPromises);
const origAppendFile = fsPromises.appendFile.bind(fsPromises);
fsPromises.writeFile = async (file, data, ...rest) => {
  if (typeof data === "string" || Buffer.isBuffer(data) || ArrayBuffer.isView(data)) {
    writeBytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  }
  return origWriteFile(file, data, ...rest);
};
fsPromises.appendFile = async (file, data, ...rest) => {
  if (typeof data === "string" || Buffer.isBuffer(data)) writeBytes += Buffer.byteLength(data);
  return origAppendFile(file, data, ...rest);
};
// fork-store's atomic writes and the journal append write through an open
// FileHandle (FileHandle is not exported in every runtime), so wrap each
// handle that fs.promises.open returns.
const origOpen = fsPromises.open.bind(fsPromises);
fsPromises.open = async (file, ...rest) => {
  const handle = await origOpen(file, ...rest);
  if (!handle.__writeInstrumented) {
    handle.__writeInstrumented = true;
    const origHandleWriteFile = handle.writeFile.bind(handle);
    handle.writeFile = (data, ...hrest) => {
      if (typeof data === "string" || Buffer.isBuffer(data) || ArrayBuffer.isView(data)) {
        writeBytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      }
      return origHandleWriteFile(data, ...hrest);
    };
  }
  return handle;
};

function sessionRow(index, total) {
  return {
    session_hash: `hash-${String(index).padStart(6, "0")}`,
    session_id: `id-${index}`,
    source: "codex",
    model: "test-model",
    started_at: "2026-07-01T00:00:00.000Z",
    ended_at: "2026-07-01T00:10:00.000Z",
    tokens: { input_tokens: total, output_tokens: 0, total_tokens: total },
    total_tokens: total,
    usage_buckets: Array.from({ length: 8 }, (_, k) => ({
      hour_start: `2026-07-01T0${k}:00:00.000Z`,
      input_tokens: 100 + index + k, output_tokens: 5 + k,
      cached_input_tokens: 3, cache_creation_input_tokens: 2,
      reasoning_output_tokens: 1, total_tokens: 111 + index + k,
    })),
    model_usage: [{ model: "test-model", input_tokens: total, output_tokens: 0, total_tokens: total }],
  };
}
const rows = (n) => Array.from({ length: n }, (_, i) => sessionRow(i, 1000 + i));
const resetWrites = () => { writeBytes = 0; };

async function measure(label, fn) {
  resetWrites();
  const started = performance.now();
  const value = await fn();
  return { label, ms: Math.round(performance.now() - started), writeBytes, value };
}

// ---------------------------------------------------------------------------
// Scenarios 1-3: storage writes, old (1.4.20) vs new (journal)
// ---------------------------------------------------------------------------
async function storageScenarios() {
  const oldStore = require(path.join(legacy, "src/lib/fork-store.js"));
  const newStore = require(path.join(repo, "src/lib/fork-store.js"));
  const N = 5500; // ≈ 9.5 MiB
  const data = rows(N);
  const reviseOne = (r, total) => r.map((x) => (x.session_hash === "hash-002500" ? sessionRow(2500, total) : x));

  const results = {};
  for (const [side, store] of [["old", oldStore], ["new", newStore]]) {
    const dir = path.join(work, `storage-${side}`);
    await fs.mkdir(path.join(dir, "fork-history"), { recursive: true });
    const file = path.join(dir, "fork-history", "sessions.json");
    const retainedKey = (r) => r.session_hash;

    const initial = await measure(`${side}:initial-full`, () => store.write(file, data));
    const noChange = await measure(`${side}:no-change`, () => store.write(file, data));
    const single = await measure(`${side}:single-revision`, () => store.write(file, reviseOne(data, 4242)));
    // Missing-source retention on both sides (union semantics).
    const retained = await measure(`${side}:source-missing-retain`, () => store.retain(path.dirname(path.dirname(file)), "sessions", [sessionRow(2500, 4242)], retainedKey));
    let smalls = [];
    let compactions = 0;
    let prevJournal = 0;
    resetWrites();
    const started = performance.now();
    for (let round = 0; round < 30; round++) {
      await store.write(file, reviseOne(data, 5000 + round));
      if (side === "new") {
        const j = await fs.stat(`${file}.journal`).then((s) => s.size, () => 0);
        if (j < prevJournal) compactions++;
        prevJournal = j;
      }
      smalls.push(writeBytes);
      resetWrites();
    }
    const smallTotalMs = Math.round(performance.now() - started);
    results[side] = {
      initialWriteBytes: initial.writeBytes,
      noChangeWriteBytes: noChange.writeBytes,
      singleRevisionWriteBytes: single.writeBytes,
      sourceMissingRetainWriteBytes: retained.writeBytes,
      sourceMissingRetainedRows: (await store.read(file, [])).length,
      repeatedSmallTotalWriteBytes: smalls.reduce((a, b) => a + b, 0),
      repeatedSmallMs: smallTotalMs,
      compactions,
      finalJournalBytes: side === "new" ? prevJournal : null,
    };
  }
  return results;
}

// ---------------------------------------------------------------------------
// Scenario 4: report refresh — six sequential individual requests vs one
// aggregate request, counting bucket parse chains and wall time.
// ---------------------------------------------------------------------------
async function reportScenario() {
  const http = require("node:http");
  const { createLocalApiHandler } = require(path.join(repo, "src/lib/local-api.js"));
  const exporter = require(path.join(repo, "src/lib/sync-store/exporter.js"));
  const dir = path.join(work, "report");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ machineId: "machine-local" }));
  const bucketRow = (h, t) => JSON.stringify({
    source: "codex", model: "gpt-5.4", hour_start: h,
    input_tokens: t, output_tokens: 0, cached_input_tokens: 0,
    cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
    total_tokens: t, billable_total_tokens: t, conversation_count: 1,
  });
  const hours = Array.from({ length: 3500 }, (_, i) => new Date(Date.UTC(2026, 9, 1, 0, i * 3) % Date.UTC(2026, 11, 1)).toISOString());
  await fs.writeFile(path.join(dir, "queue.jsonl"), hours.map((h, i) => bucketRow(h, 100 + i)).join("\n") + "\n");

  const originalBuild = exporter.buildBucketsRows;
  let parses = 0;
  exporter.buildBucketsRows = (...a) => { parses++; return originalBuild(...a); };
  const handler = createLocalApiHandler({ queuePath: path.join(dir, "queue.jsonl"), trackerDataDir: dir });
  const server = http.createServer((req, res) => {
    handler(req, res, new URL(req.url || "/", "http://127.0.0.1")).catch(() => {
      res.writeHead(500); res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(base + "/api/local-auth")).json();
  const get = async (p) => { const r = await fetch(base + p, { headers: { "x-tokentracker-local-auth": token } }); if (!r.ok) throw new Error(p); return r.json(); };
  const params = "from=2026-10-01&to=2026-11-01&previous_from=2026-09-01&previous_to=2026-09-30&device_id=all";
  const paths = [
    `/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-11-01&device_id=all`,
    `/functions/tokentracker-usage-summary?from=2026-09-01&to=2026-09-30&device_id=all`,
    `/functions/tokentracker-usage-daily?from=2026-10-01&to=2026-11-01&device_id=all`,
    `/functions/tokentracker-usage-model-breakdown?from=2026-10-01&to=2026-11-01&device_id=all`,
    `/functions/tokentracker-project-usage-summary?from=2026-10-01&to=2026-11-01&device_id=all`,
    `/api/fork/device-usage?from=2026-10-01&to=2026-11-01`,
  ];
  // Warm caches once so both sides see the same (warm) conditions.
  await get(`/api/fork/report?${params}`);
  parses = 0;
  let t0 = performance.now();
  for (const p of paths) await get(p);
  const oldMs = Math.round(performance.now() - t0);
  const oldParses = parses;
  parses = 0;
  t0 = performance.now();
  await get(`/api/fork/report?${params}`);
  const newMs = Math.round(performance.now() - t0);
  const newParses = parses;
  exporter.buildBucketsRows = originalBuild;
  await new Promise((r) => server.close(r));
  return { oldRequestCount: paths.length, oldParses, oldMs, newRequestCount: 1, newParses, newMs };
}

// ---------------------------------------------------------------------------
// Scenario 5: two-device sync upload payload — full-union seg (1.4.20
// behavior) vs delta seg for the same one-row change.
// ---------------------------------------------------------------------------
async function syncPayloadScenario() {
  const { serializeDocument } = require(path.join(repo, "src/lib/sync-store/format.js"));
  const N = 5500;
  const bucketRow = (i) => ({
    source: "codex", model: "gpt-5.4", hour_start: new Date(Date.UTC(2026, 9, 1, 0, i * 3) % Date.UTC(2026, 11, 1)).toISOString(),
    input_tokens: 100 + i, output_tokens: 0, cached_input_tokens: 0,
    cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
    total_tokens: 100 + i, billable_total_tokens: 100 + i, conversation_count: 1, device: "machine-a",
  });
  const all = Array.from({ length: N }, (_, i) => bucketRow(i));
  const revised = all.map((r, i) => (i === 2500 ? { ...r, total_tokens: 4242, input_tokens: 4242, billable_total_tokens: 4242 } : r));
  const oldSeg = serializeDocument({ kind: "buckets", device: "machine-a", seq: 2, sinceSeq: 1, rows: revised });
  const deltaRow = revised[2500];
  const newSeg = serializeDocument({ kind: "buckets", device: "machine-a", seq: 2, sinceSeq: 1, rows: [deltaRow] });
  const zeroSeg = serializeDocument({ kind: "buckets", device: "machine-a", seq: 2, sinceSeq: 1, rows: [] });
  return {
    rows: N,
    oldFullSegBytes: Buffer.byteLength(oldSeg),
    newDeltaSegBytes: Buffer.byteLength(newSeg),
    zeroChangeSegBytes: Buffer.byteLength(zeroSeg),
    reductionRatio: Number((Buffer.byteLength(newSeg) / Buffer.byteLength(oldSeg)).toFixed(5)),
  };
}

(async () => {
  const results = {
    generated_at: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    metric_note: "writeBytes = fs writeFile/appendFile payload bytes in this process; parses = exporter.buildBucketsRows invocations; ms = process-local wall time. Not SSD wear, not battery.",
    storage: await storageScenarios(),
    report: await reportScenario(),
    syncPayload: await syncPayloadScenario(),
  };
  const out = path.join(outDir, "performance-1.5.0-measured.json");
  await origWriteFile(out, JSON.stringify(results, null, 2));
  console.log("written", out);
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
