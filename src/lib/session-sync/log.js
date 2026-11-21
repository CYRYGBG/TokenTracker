"use strict";

// Local usage log for the manual conversation sync (SYNC_DESIGN §12.2).
// Append-only JSONL at <trackerDir>/session-sync/log.jsonl, rotated once past
// MAX_BYTES to log.jsonl.1 (one previous generation kept). Records metadata
// only — agent, ids, titles, sizes, durations, structured codes — never
// conversation content, credentials, or remote URLs. Local-only: the file is
// never synced and exists so real usage patterns can drive the next round of
// optimization.

const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_BYTES = 1024 * 1024;
const LOG_NAME = "log.jsonl";

function logPathFor(trackerDir) {
  return path.join(trackerDir, "session-sync", LOG_NAME);
}

function rotatedPathFor(trackerDir) {
  return path.join(trackerDir, "session-sync", `${LOG_NAME}.1`);
}

function truncateText(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

// Sanitize one event into the on-disk shape. Unknown fields are dropped so
// accidental payloads (message bodies, URLs) can never leak into the log.
const ALLOWED_FIELDS = new Set([
  "jobId", "jobType", "itemCount", "agent", "sessionId", "title",
  "device", "deviceName", "status", "code", "message",
  "bytes", "revision", "durationMs", "backup", "insertedMessages",
  "deviceCount", "sessionCount", "doneCount", "errorCount",
]);

function sanitizeEvent(event) {
  const out = {};
  for (const [key, value] of Object.entries(event || {})) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (key === "title") {
      out.title = truncateText(value, 120);
    } else if (key === "message") {
      out.message = truncateText(value, 200);
    } else if (key === "deviceName") {
      out.deviceName = truncateText(value, 80);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string" && value.length <= 128) {
      out[key] = value;
    }
  }
  return out;
}

async function appendEvent(trackerDir, type, event = {}) {
  const file = logPathFor(trackerDir);
  const line = JSON.stringify({ ts: new Date().toISOString(), type, ...sanitizeEvent(event) }) + "\n";
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      const st = await fs.stat(file);
      if (st.size >= MAX_BYTES) {
        await fs.rename(file, rotatedPathFor(trackerDir)).catch(() => {});
      }
    } catch { /* fresh log */ }
    await fs.appendFile(file, line, "utf8");
  } catch {
    // The usage log is a diagnostic aid; a failure to record must never fail
    // the operation it describes.
  }
}

async function readEvents(trackerDir, { maxEvents = 5000 } = {}) {
  const files = [rotatedPathFor(trackerDir), logPathFor(trackerDir)];
  const events = [];
  for (const file of files) {
    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch { continue; }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch { /* tolerate torn tail lines */ }
    }
  }
  return maxEvents > 0 ? events.slice(-maxEvents) : events;
}

module.exports = { appendEvent, readEvents, logPathFor, rotatedPathFor, sanitizeEvent, MAX_BYTES };
