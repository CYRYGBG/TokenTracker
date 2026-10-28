// Hard-capped zstd decompression.
//
// The sync decoders (zlib.zstdDecompressSync / @mongodb-js/zstd) allocate the
// full output buffer up front — sized by the frame's declared content size, or
// by whatever a corrupt/aborted frame header claims, or (for frames without a
// declared size) grown until decompression finishes. One huge or malformed
// frame can therefore spike commit memory by gigabytes before any size check
// runs. A live-appended archive re-decoded every scan cycle turned that into a
// periodic multi-GB sawtooth on the resident serve process (2026-10-28
// incident: 8GB commit, Windows "low on memory" 2004 events, RADAR leak
// detection firing on node.exe).
//
// decodeZstdBounded streams the frame through zlib.createZstdDecompress into a
// counting destination and destroys the decompressor as soon as the cap is
// crossed, so no payload can ever allocate beyond cap + one chunk. Callers
// keep their existing per-payload caps; this module only makes them real.

const zlib = require("node:zlib");
const { Readable, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

class ZstdOutputCapExceededError extends Error {
  constructor(maxOutputBytes) {
    super(`zstd output exceeds ${maxOutputBytes} byte cap`);
    this.name = "ZstdOutputCapExceededError";
    this.code = "ZSTD_OUTPUT_CAP_EXCEEDED";
    this.maxOutputBytes = maxOutputBytes;
  }
}

// Node 22.15+ exposes the zstd stream API; the desktop bundles install with
// --ignore-scripts, so the @mongodb-js/zstd napi fallback cannot load there
// and every path must use this decoder on those runtimes. Node 20 CLI
// installs (npm ran install scripts) keep the legacy fallback in the callers.
function supportsBoundedStreamDecode() {
  return typeof zlib.createZstdDecompress === "function";
}

async function decodeZstdBounded(input, { maxOutputBytes, label = "zstd" } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const limit = Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 0
    ? maxOutputBytes
    : null;
  if (limit === null) {
    throw new TypeError(`${label}: maxOutputBytes must be a non-negative safe integer`);
  }
  if (!supportsBoundedStreamDecode()) {
    // One-shot CLI installs only (short-lived child process, native binding
    // present). Unbounded like the decoders this module replaces; the
    // desktop bundle never takes this branch (see supportsBoundedStreamDecode).
    return Buffer.from(await require("@mongodb-js/zstd").decompress(buffer));
  }
  const chunks = [];
  let total = 0;
  const dest = new Writable({
    write(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > limit) {
        chunks.length = 0;
        callback(new ZstdOutputCapExceededError(limit));
        return;
      }
      chunks.push(chunk);
      callback();
    },
  });
  // Destroying the destination tears down the whole pipeline, so the
  // decompressor stops producing (and allocating) shortly after the cap.
  await pipeline(Readable.from([buffer]), zlib.createZstdDecompress(), dest);
  return Buffer.concat(chunks, total);
}

module.exports = {
  ZstdOutputCapExceededError,
  decodeZstdBounded,
  supportsBoundedStreamDecode,
};
