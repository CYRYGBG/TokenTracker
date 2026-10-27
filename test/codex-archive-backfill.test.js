const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const zstd = require("@mongodb-js/zstd");

const { cmdSync } = require("../src/commands/sync");
const { drainCodexCollectionGaps, readCodexRolloutSnapshot } = require("../src/lib/rollout");

const BACKFILL_KEY = "codexArchiveBackfill_2026_10_fork";
const SYNC_ARGS = ["--auto", "--background", "--all-local-sources"];

test("archive permission errors are recorded without exposing content", async (t) => {
  drainCodexCollectionGaps();
  const originalOpen = fs.open;
  const file = "/fixture/permission-denied.jsonl.zst";
  t.mock.method(fs, "open", async (target, ...args) => {
    if (target === file) throw Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
    return originalOpen.call(fs, target, ...args);
  });
  assert.equal(await readCodexRolloutSnapshot(file), null);
  assert.deepEqual(drainCodexCollectionGaps(), [{ path: file, reason: "read-error", detail: "EACCES", count: 1 }]);
});

function buildTokenCountLine({ ts, last, total }) {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: {
      type: "token_count",
      info: { last_token_usage: last, total_token_usage: total },
    },
  });
}

async function writeCodexFixture(home) {
  // A recent rollout under the strict sessions/YYYY/MM/DD tree plus an older
  // session already moved by Codex into the flat zstd archive directory.
  const sessionsDir = path.join(home, ".codex", "sessions", "2026", "10", "26");
  await fs.mkdir(sessionsDir, { recursive: true });
  const liveUsage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15 };
  await fs.writeFile(
    path.join(sessionsDir, "rollout-2026-10-26T10-00-00-01234567-89ab-cdef-0123-456789abcdef.jsonl"),
    [
      buildTokenCountLine({ ts: "2026-10-26T10:00:00.000Z", last: liveUsage, total: liveUsage }),
    ].join("\n") + "\n",
    "utf8",
  );

  const archiveDir = path.join(home, ".codex", "archived_sessions");
  await fs.mkdir(archiveDir, { recursive: true });
  const archiveUsage = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 150 };
  const archiveText = [
    buildTokenCountLine({ ts: "2026-09-12T17:26:00.000Z", last: archiveUsage, total: archiveUsage }),
  ].join("\n") + "\n";
  const compressed = await zstd.compress(Buffer.from(archiveText, "utf8"));
  await fs.writeFile(
    path.join(archiveDir, "rollout-2026-09-12T17-26-00-89abcdef-0123-4567-89ab-cdef01234567.jsonl.zst"),
    compressed,
  );
  return { liveTotal: liveUsage.total_tokens, archiveTotal: archiveUsage.total_tokens };
}

async function readQueueTotals(trackerDir) {
  const rows = (await fs.readFile(path.join(trackerDir, "queue.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  return {
    codexTokens: rows
      .filter((row) => row.source === "codex")
      .reduce((sum, row) => sum + Number(row.total_tokens || 0), 0),
    rowCount: rows.length,
  };
}

test("background sync backfills archived_sessions history on fresh installs exactly once", async () => {
  drainCodexCollectionGaps();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-backfill-home-"));
  const trackerDir = path.join(home, ".tokentracker-personal", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });
  try {
    const fixture = await writeCodexFixture(home);

    await cmdSync(SYNC_ARGS, { home, trackerDataDir: trackerDir });

    // The lightweight pass must have reached the archive, not just sessions/.
    const afterFirst = await readQueueTotals(trackerDir);
    assert.equal(
      afterFirst.codexTokens,
      fixture.liveTotal + fixture.archiveTotal,
      "first background sync must count both the live rollout and the archived snapshot",
    );
    const cursors = JSON.parse(await fs.readFile(path.join(trackerDir, "cursors.json"), "utf8"));
    assert.match(
      String(cursors.migrations?.[BACKFILL_KEY] || ""),
      /^\d{4}-\d{2}-\d{2}T/,
      "completed backfill must be recorded as a final ISO migration timestamp",
    );

    // The escalation is one-shot: the second lightweight sync must not change
    // any totals (archive re-reads dedup as no-ops anyway).
    await cmdSync(SYNC_ARGS, { home, trackerDataDir: trackerDir });
    const afterSecond = await readQueueTotals(trackerDir);
    assert.equal(afterSecond.rowCount, afterFirst.rowCount);
    assert.equal(afterSecond.codexTokens, afterFirst.codexTokens);

    // Clean archives produce no collection gaps.
    let gapsFile = null;
    try {
      gapsFile = await fs.readFile(path.join(trackerDir, "collection-gaps.json"), "utf8");
    } catch {
      gapsFile = null;
    }
    assert.equal(gapsFile, null, "no collection-gaps.json expected without unreadable archives");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("an unreadable archive is soft-skipped and recorded in the collection-gap ledger", async () => {
  drainCodexCollectionGaps();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-backfill-gap-"));
  const trackerDir = path.join(home, ".tokentracker-personal", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });
  try {
    const { liveTotal, archiveTotal } = await writeCodexFixture(home);
    const archiveDir = path.join(home, ".codex", "archived_sessions");
    await fs.writeFile(
      path.join(archiveDir, "rollout-2026-08-01T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl.zst"),
      Buffer.from("this is not zstd data", "utf8"),
    );

    await cmdSync(SYNC_ARGS, { home, trackerDataDir: trackerDir });

    const totals = await readQueueTotals(trackerDir);
    assert.equal(
      totals.codexTokens,
      liveTotal + archiveTotal,
      "the unreadable archive contributes nothing; readable rollouts still count",
    );

    const ledger = JSON.parse(await fs.readFile(path.join(trackerDir, "collection-gaps.json"), "utf8"));
    const entries = Object.values(ledger);
    assert.equal(entries.length, 1, "the unreadable archive must be the only recorded gap");
    assert.equal(entries[0].reason, "decode-failed");
    assert.ok(entries[0].path.endsWith("rollout-2026-08-01T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl.zst"));
    assert.match(String(entries[0].firstSeenAt), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    drainCodexCollectionGaps();
  }
});
test("background collection retries archives after a temporary failure", async () => {
 const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-review-backfill-"));
 const trackerDir=path.join(home,".tokentracker-personal/tracker");
 await fs.mkdir(trackerDir,{recursive:true});
 try {
  await writeCodexFixture(home);
  const file=path.join(home,".codex/archived_sessions/rollout-2026-08-01T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl.zst");
  await fs.writeFile(file,Buffer.from("temporarily incomplete archive"));
  await cmdSync(SYNC_ARGS,{home,trackerDataDir:trackerDir});
  const first=await readQueueTotals(trackerDir);
  const usage={input_tokens:200,cached_input_tokens:0,output_tokens:100,reasoning_output_tokens:0,total_tokens:300};
  const text=buildTokenCountLine({ts:"2026-08-01T00:00:00.000Z",last:usage,total:usage})+"\n";
  await fs.writeFile(file,await zstd.compress(Buffer.from(text)));
  await cmdSync(SYNC_ARGS,{home,trackerDataDir:trackerDir});
  const second=await readQueueTotals(trackerDir);
  await cmdSync(["--auto","--all-local-sources"],{home,trackerDataDir:trackerDir});
  const manual=await readQueueTotals(trackerDir);
  console.log("REVIEW_TOTALS",JSON.stringify({first:first.codexTokens,backgroundAfterRepair:second.codexTokens,fullAfterRepair:manual.codexTokens}));
  assert.equal(second.codexTokens,465,"background must recover after a temporary archive failure");
 } finally {await fs.rm(home,{recursive:true,force:true});drainCodexCollectionGaps();}
});
