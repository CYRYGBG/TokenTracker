const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  ZstdOutputCapExceededError,
  decodeZstdBounded,
  supportsBoundedStreamDecode,
} = require("../src/lib/zstd-bounded");
const { decodeDshZstd, drainCodexCollectionGaps, readCodexRolloutSnapshot } = require("../src/lib/rollout");

const canStream = supportsBoundedStreamDecode();

async function withTempDir(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zstd-bounded-"));
  try {
    return await callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("decodeZstdBounded round-trips a payload within its cap", async () => {
  const payload = Buffer.from("hello bounded zstd\n".repeat(1000));
  const compressed = zlib.zstdCompressSync(payload);
  const decoded = await decodeZstdBounded(compressed, { maxOutputBytes: payload.length + 1024 });
  assert.equal(decoded.toString("utf8"), payload.toString("utf8"));
});

test("decodeZstdBounded refuses output beyond the cap instead of allocating it", async () => {
  if (!canStream) return; // legacy fallback path is unbounded by design
  // ~8MB of zeros compresses to a few KB: a declared or grown output far over
  // the 1MB cap. The sync decoders would allocate all 8MB before any check.
  const payload = Buffer.alloc(8 * 1024 * 1024, 0x61);
  const compressed = zlib.zstdCompressSync(payload);
  await assert.rejects(
    () => decodeZstdBounded(compressed, { maxOutputBytes: 1024 * 1024 }),
    (error) => error instanceof ZstdOutputCapExceededError
      && error.code === "ZSTD_OUTPUT_CAP_EXCEEDED"
      && error.maxOutputBytes === 1024 * 1024,
  );
});

test("decodeDshZstd enforces the remaining budget on each frame", async () => {
  if (!canStream) return;
  // Stream-compressed frames omit the declared content size, so the frame
  // inspector's declared-size pre-check cannot refuse them and the per-frame
  // budget cap is the only guard. Two ~600KB frames under a 1MB aggregate
  // cap: the second frame only has ~424KB of budget left.
  const frame = await compressWithoutDeclaredSize(Buffer.alloc(600 * 1024, 0x62));
  const archive = Buffer.concat([frame, frame]);
  await assert.rejects(
    () => decodeDshZstd(archive, { maxOutputBytes: 1024 * 1024 }),
    (error) => error.code === "ZSTD_OUTPUT_CAP_EXCEEDED",
  );
});

// Compress through the streaming API, which writes a frame header without the
// optional Frame_Content_Size field (zstdCompressSync declares the size).
function compressWithoutDeclaredSize(payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const compressor = zlib.createZstdCompress();
    compressor.on("data", (chunk) => chunks.push(chunk));
    compressor.on("error", reject);
    compressor.on("end", () => resolve(Buffer.concat(chunks)));
    compressor.end(payload);
  });
}

test("readCodexRolloutSnapshot decodes a normal archive and keeps failing archives bounded", async () => {
  await withTempDir(async (dir) => {
    const lines = Array.from({ length: 50 }, (_, i) => `{"line":${i},"text":"${"x".repeat(200)}"}`);
    const archive = path.join(dir, "rollout-2026-10-28T00-00-00-test.jsonl.zst");
    fs.writeFileSync(archive, zlib.zstdCompressSync(Buffer.from(lines.join("\n"))));
    const snapshot = await readCodexRolloutSnapshot(archive);
    assert.ok(snapshot, "normal archive must decode");
    assert.equal(snapshot.lines.length, lines.length);

    // A compressed file already larger than the configured output cap must be
    // refused from the stat, before its compressed bytes are read into memory.
    drainCodexCollectionGaps();
    const bigArchive = path.join(dir, "rollout-2026-10-28T00-00-01-big.jsonl.zst");
    // Random bytes are incompressible, so the compressed file (~64KB) itself
    // exceeds the 32KB output cap.
    fs.writeFileSync(bigArchive, require("node:crypto").randomBytes(64 * 1024));
    const refused = await readCodexRolloutSnapshot(bigArchive, { maxOutputBytes: 32 * 1024 });
    assert.equal(refused, null, "archive over the output cap must be refused");
    const gaps = drainCodexCollectionGaps();
    assert.ok(
      gaps.some((gap) => gap.path === bigArchive && gap.reason === "oversized-archive"),
      `expected an oversized-archive gap, got ${JSON.stringify(gaps)}`,
    );
  });
});
