// Fork sync document format (docs/fork/SYNC_DESIGN.md §2).
//
// Every file is JSONL with three parts:
//   1. header line: {"fork_sync":1,"kind":...,"device":...,"seq":N,"since_seq":M,
//                    "rows":R,"sha256":"<payload-hash>"}
//   2. R payload lines (one JSON row each)
//   3. trailer line: {"end":true}
//
// sha256 covers exactly the payload bytes (all lines between header and
// trailer, each with its trailing newline), so a truncated or mid-write file
// fails validation instead of silently importing partial data.

const crypto = require("node:crypto");

const FORMAT_VERSION = 1;
const TRAILER = JSON.stringify({ end: true });

function payloadBytes(rows) {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

function payloadSha256(payload) {
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

function serializeDocument({ kind, device, seq, sinceSeq = null, rows, generatedAt }) {
  if (!kind || typeof kind !== "string") throw new Error("document kind is required");
  if (!device || typeof device !== "string") throw new Error("device id is required");
  const sequence = Number(seq);
  if (!Number.isInteger(sequence) || sequence <= 0) throw new Error("document seq must be a positive integer");
  const payload = payloadBytes(rows);
  const header = {
    fork_sync: FORMAT_VERSION,
    kind,
    device,
    seq: sequence,
    since_seq: sinceSeq == null ? null : Number(sinceSeq),
    rows: rows.length,
    sha256: payloadSha256(payload),
    generated_at: generatedAt || new Date().toISOString(),
  };
  return `${JSON.stringify(header)}\n${payload}${TRAILER}\n`;
}

// Returns { header, rows } on success; throws with code=WEBDAV_DOC_INVALID (and
// a reason) on any structural mismatch. `maxRows` bounds memory on hostile or
// corrupt files.
function parseDocument(text, { maxRows = 2_000_000 } = {}) {
  const fail = (reason) => {
    const error = new Error(`invalid fork sync document: ${reason}`);
    error.code = "WEBDAV_DOC_INVALID";
    error.reason = reason;
    throw error;
  };
  if (typeof text !== "string" || text.length === 0) return fail("empty document");
  const lines = text.split("\n");
  // A well-formed document ends with the trailer line + final newline.
  if (lines[lines.length - 1] !== "") return fail("missing final newline (truncated write)");
  lines.pop();
  if (lines.length < 2) return fail("no payload");
  const trailer = lines[lines.length - 1];
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return fail("unparseable header");
  }
  try {
    if (JSON.parse(trailer).end !== true) return fail("missing end trailer");
  } catch {
    return fail("unparseable trailer");
  }
  if (!header || header.fork_sync !== FORMAT_VERSION) {
    const error = new Error(`unsupported fork sync format version: ${header?.fork_sync}`);
    error.code = "WEBDAV_DOC_VERSION";
    error.version = header?.fork_sync;
    throw error;
  }
  const declaredRows = Number(header.rows);
  const payloadLines = lines.slice(1, lines.length - 1);
  if (!Number.isInteger(declaredRows) || declaredRows < 0) return fail("bad rows count");
  if (payloadLines.length !== declaredRows) {
    return fail(`row count mismatch (header ${declaredRows}, actual ${payloadLines.length})`);
  }
  if (payloadLines.length > maxRows) return fail(`row count exceeds limit ${maxRows}`);
  const rows = [];
  for (const line of payloadLines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return fail("unparseable payload row");
    }
    rows.push(row);
  }
  const actualHash = payloadSha256(payloadBytes(rows));
  if (actualHash !== header.sha256) {
    return fail("payload checksum mismatch (half-written file)");
  }
  return { header, rows };
}

// File name helpers — sequence-ordered, immutable once written.
function baseFileName(kind, seq) {
  return `${kind}-base-${padSeq(seq)}.jsonl`;
}

function segmentFileName(kind, seq) {
  return `${kind}-seg-${padSeq(seq)}.jsonl`;
}

function padSeq(seq) {
  return String(Number(seq)).padStart(10, "0");
}

// Parses "<kind>-<base|seg>-<seq>.jsonl"; returns null for foreign names.
function parseDocFileName(name) {
  const match = /^([a-z0-9-]+)-(base|seg)-(\d{10,})\.jsonl$/.exec(name || "");
  if (!match) return null;
  return { kind: match[1], variant: match[2], seq: Number(match[3]) };
}

function deviceDocumentPath(rootDir, machineId, fileName) {
  return [rootDir, "devices", machineId, fileName].filter(Boolean).join("/");
}

module.exports = {
  FORMAT_VERSION,
  serializeDocument,
  parseDocument,
  baseFileName,
  segmentFileName,
  parseDocFileName,
  deviceDocumentPath,
  payloadSha256,
};
