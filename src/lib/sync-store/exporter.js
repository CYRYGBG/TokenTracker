// Builds export snapshots for the fork sync from THIS device's local ledger
// (queue.jsonl / project.queue.jsonl / session sidecar). Never reads the
// import store — structural separation so imported data can never be
// re-exported as if it were local usage (SYNC_DESIGN §1.3).

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const { payloadSha256 } = require("./format");
const { isAccountLevelSource } = require("../source-metadata");

// Account-level sources: usage measured per vendor ACCOUNT, not per device.
// Authoritative list lives in src/lib/source-metadata.js.
const accountLevelSource = isAccountLevelSource;

// Queue kinds that ride along for account-level dedup instead of the bucket
// stream (same classification the upstream cloud ingest used).
const QUEUE_CONTROL_KINDS = new Set(["account_session_state", "account_sync_watermark"]);

// Reads queue.jsonl applying the same last-wins-per-key semantics as every
// local reader, plus the same legacy-row normalization local-api applies.
function readLocalBuckets(queuePath) {
  const localApi = require("../local-api");
  const buckets = new Map();
  const sessionStates = new Map();
  const sessionStateStamps = new Map();
  let raw = "";
  try {
    raw = require("node:fs").readFileSync(queuePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { buckets: [], sessionStates: [] };
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.kind === "account_session_state") {
      if (typeof row.source === "string" && typeof row.session_id === "string" && row.session_id.trim()) {
        const key = `${String(row.source).trim().toLowerCase()}|${row.session_id.trim()}`;
        const stamp = Date.parse(row.snapshot_verified_at || "") || null;
        const prior = sessionStateStamps.get(key);
        if (!sessionStates.has(key) || (stamp !== null && (prior === null || stamp > prior))) {
          sessionStates.set(key, row);
          sessionStateStamps.set(key, stamp);
        }
      }
      continue;
    }
    if (row?.kind && QUEUE_CONTROL_KINDS.has(row.kind)) continue;
    if (typeof row?.hour_start !== "string" || !row.hour_start) continue;
    const source = (typeof row.source === "string" ? row.source.trim().toLowerCase() : "") || "codex";
    const model = (typeof row.model === "string" ? row.model.trim() : "") || "unknown";
    const normalized = localApi.normalizeQueueRow({ ...row, source, model });
    buckets.set(`${source}|${model}|${row.hour_start}`, normalized);
  }
  return {
    buckets: Array.from(buckets.values()),
    sessionStates: Array.from(sessionStates.values()),
  };
}

function readLocalProjectBuckets(projectQueuePath) {
  const buckets = new Map();
  let raw = "";
  try {
    raw = require("node:fs").readFileSync(projectQueuePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row?.hour_start !== "string" || !row.hour_start) continue;
    if (typeof row.project_key !== "string" || !row.project_key) continue;
    const source = (typeof row.source === "string" ? row.source.trim().toLowerCase() : "") || "codex";
    buckets.set(`${row.project_key}|${source}|${row.hour_start}`, { ...row, source });
  }
  return Array.from(buckets.values());
}

// Defensive credential scan (SYNC_DESIGN §6): refuse to export any project
// reference that still embeds user:pass@ or an ssh-style git identity.
function containsCredentialHint(value) {
  if (typeof value !== "string") return false;
  return /:\/\/[^\s/@]+:[^\s/@]+@/i.test(value) || /^git@/i.test(value.trim()) || /\/(oauth2|token):/i.test(value);
}

function sanitizeProjectRow(row) {
  const projectRef = typeof row.project_ref === "string" ? row.project_ref : null;
  if (projectRef && containsCredentialHint(projectRef)) {
    return { ...row, project_ref: null, credential_redacted: true };
  }
  return row;
}

// Rows exported for the buckets document: bucket rows tagged with the device
// id, plus account session-state control rows (kind kept verbatim).
function buildBucketsRows({ queuePath, machineId }) {
  const { buckets, sessionStates } = readLocalBuckets(queuePath);
  const privacy = require("./privacy");
  const rows = buckets.map((row) => privacy.bucket(row, machineId));
  for (const state of sessionStates) rows.push(privacy.bucket(state, machineId));
  return rows;
}

function buildProjectsRows({ projectQueuePath, machineId }) {
  return readLocalProjectBuckets(projectQueuePath)
    .map((row) => require("./privacy").project(row, machineId));
}

function stableRowsHash(rows) {
  const canonical = rows
    .map((row) => JSON.stringify(row))
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

// Splits rows into (unchanged, changed) vs the previous exported row set
// (keyed by rowKeyOf) so segments only carry what actually moved.
function diffRowsByKey({ rows, previous, rowKeyOf }) {
  const previousByKey = new Map(previous.map((row) => [rowKeyOf(row), row]));
  const nextByKey = new Map(rows.map((row) => [rowKeyOf(row), row]));
  const changed = [];
  for (const [key, row] of nextByKey) {
    const prior = previousByKey.get(key);
    if (!prior || JSON.stringify(prior) !== JSON.stringify(row)) changed.push(row);
  }
  return changed;
}

function bucketRowKey(row) {
  if (row?.kind === "account_session_state") {
    return `state|${row.source}|${row.session_id}`;
  }
  return `${row.source}|${row.model}|${row.hour_start}`;
}

function projectRowKey(row) {
  return `${row.project_key}|${row.source}|${row.hour_start}`;
}

module.exports = {
  accountLevelSource,
  readLocalBuckets,
  readLocalProjectBuckets,
  buildBucketsRows,
  buildProjectsRows,
  sanitizeProjectRow,
  containsCredentialHint,
  stableRowsHash,
  diffRowsByKey,
  bucketRowKey,
  projectRowKey,
};
