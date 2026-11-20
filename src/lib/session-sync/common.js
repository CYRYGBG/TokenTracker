"use strict";

// Shared helpers for the manual cross-device conversation sync
// (docs/fork/SYNC_DESIGN.md §12, REQUIREMENTS §13). Everything here is
// deliberately dependency-free aside from node builtins so the module can be
// exercised from tests with fixture directories.

const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const AGENTS = ["codex", "zcode", "antigravity"];

// Jianguoyun free tier meters monthly traffic; payloads beyond this are almost
// certainly a mistake (an entire brain dir, a runaway transcript).
const MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sessionSyncDirFor(trackerDir) {
  return path.join(trackerDir, "session-sync");
}

function registryPathFor(trackerDir) {
  return path.join(sessionSyncDirFor(trackerDir), "registry.json");
}

function jobPathFor(trackerDir) {
  return path.join(sessionSyncDirFor(trackerDir), "job.json");
}

function importedMessageIdsPathFor(trackerDir) {
  return path.join(sessionSyncDirFor(trackerDir), "imported-message-ids.json");
}

function backupsDirFor(trackerDir) {
  return path.join(sessionSyncDirFor(trackerDir), "backups");
}

function isValidAgent(value) {
  return AGENTS.includes(value);
}

// Session ids and machine ids end up as remote path segments. Keep them
// strictly filesystem- and URL-safe rather than trusting the source store.
function isValidSessionId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
}

// Payload keys are relative paths under the bundle. No absolute paths, no
// "..", no backslash, no control chars — they become WebDAV segments.
function isValidPayloadKey(key) {
  if (typeof key !== "string" || !key || key.length > 512) return false;
  if (key.includes("\\") || key.includes("\0")) return false;
  if (/[\r\n]/.test(key)) return false;
  const parts = key.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  return true;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return { sha256: sha256(buffer), bytes: buffer.byteLength };
}

function gzipBuffer(buffer) {
  return zlib.gzipSync(buffer, { level: 6 });
}

function gunzipBuffer(buffer) {
  return zlib.gunzipSync(buffer);
}

// Walk a directory tree and return [{key, absPath, bytes}] where key is the
// /-separated relative path. Symlinks are skipped: a session dir must be a
// plain tree we can reproduce byte-for-byte on the other machine.
async function walkTree(root, { maxFiles = 5000 } = {}) {
  const out = [];
  const stack = [{ dir: root, prefix: "" }];
  while (stack.length > 0) {
    const { dir, prefix } = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (out.length + stack.length > maxFiles) continue;
        stack.push({ dir: abs, prefix: key });
      } else if (entry.isFile()) {
        if (out.length >= maxFiles) {
          const error = new Error(`session bundle exceeds ${maxFiles} files`);
          error.code = "SESSION_SYNC_BUNDLE_TOO_LARGE";
          throw error;
        }
        const st = await fs.stat(abs);
        out.push({ key, absPath: abs, bytes: st.size });
      }
    }
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

// Timestamped backup name preserving the original extension.
function backupFileName(key) {
  const safe = key.replace(/[\\/]/g, "__");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}--${safe}`;
}

function nowIso() {
  return new Date().toISOString();
}

function statOrNull(filePath) {
  try {
    return fssync.statSync(filePath);
  } catch {
    return null;
  }
}

module.exports = {
  AGENTS,
  MAX_PAYLOAD_BYTES,
  sha256,
  sha256File,
  gzipBuffer,
  gunzipBuffer,
  sessionSyncDirFor,
  registryPathFor,
  jobPathFor,
  importedMessageIdsPathFor,
  backupsDirFor,
  isValidAgent,
  isValidSessionId,
  isValidPayloadKey,
  readJson,
  writeJsonAtomic,
  walkTree,
  backupFileName,
  nowIso,
  statOrNull,
};
