"use strict";

// Antigravity adapter for the manual conversation sync.
//
// One conversation = one directory under
// <geminiHome>/antigravity{,-ide,-insiders,-cli}/brain/<uuid>/ containing
// .system_generated/logs/transcript.jsonl plus sibling db/memory files. The
// bundle mirrors the whole directory tree; the transcript's cursor entry
// (lastLine/context snapshots) rides in meta and is re-anchored on import so
// the scanner only counts real appends (SYNC_DESIGN §12.4).

const fs = require("node:fs/promises");
const path = require("node:path");

const { openCursorStore } = require("../../cursor-store");
const { resolveAntigravityBrainDirs } = require("../../rollout");
const {
  sha256,
  sha256File,
  walkTree,
  backupFileName,
  isValidPayloadKey,
  statOrNull,
} = require("../common");

const AGENT = "antigravity";

function geminiHome(home, env = process.env) {
  const override = typeof env.GEMINI_HOME === "string" && env.GEMINI_HOME.trim()
    ? env.GEMINI_HOME.trim()
    : null;
  return override || path.join(home, ".gemini");
}

function brainRoots(home, env) {
  return resolveAntigravityBrainDirs(geminiHome(home, env));
}

// Import lands in the first brain root that exists locally; a machine with no
// Antigravity install gets the primary path so a later install finds it.
function targetBrainRoot(home, env) {
  const roots = brainRoots(home, env);
  for (const root of roots) {
    if (statOrNull(root)) return root;
  }
  return roots[0] || path.join(geminiHome(home, env), "antigravity", "brain");
}

async function listConversations({ home, env }) {
  const out = [];
  for (const root of brainRoots(home, env)) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^[0-9a-fA-F-]{8,64}$/.test(entry.name)) continue;
      const sessionDir = path.join(root, entry.name);
      const transcript = path.join(sessionDir, ".system_generated", "logs", "transcript.jsonl");
      const st = statOrNull(transcript);
      if (!st) continue;
      out.push({
        agent: AGENT,
        sessionId: entry.name,
        absPath: transcript,
        sessionDir,
        relativeKey: `${entry.name}`,
        bytes: st.size,
        updatedAtMs: st.mtimeMs,
        title: await deriveTitle(transcript).catch(() => null),
        cwd: null,
        project: null,
      });
    }
  }
  out.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return out;
}

async function deriveTitle(transcriptPath) {
  const handle = await fs.open(transcriptPath, "r");
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, 128 * 1024));
    await handle.read(head, 0, head.byteLength, 0);
    for (const line of head.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type === "USER_INPUT" && typeof parsed.content === "string" && parsed.content.trim()) {
          return parsed.content.trim().slice(0, 120);
        }
      } catch { /* tolerate partial head lines */ }
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function findConversation(home, env, sessionId) {
  const items = await listConversations({ home, env });
  return items.find((item) => item.sessionId === sessionId) || null;
}

async function prepareUpload({ home, env, trackerDir, sessionId }) {
  const item = await findConversation(home, env, sessionId);
  if (!item) {
    const error = new Error("antigravity session not found");
    error.code = "SESSION_SYNC_LOCAL_MISSING";
    throw error;
  }
  const files = [];
  for (const file of await walkTree(item.sessionDir, { maxFiles: 2000 })) {
    const buffer = await fs.readFile(file.absPath);
    files.push({ key: `${sessionId}/${file.key}`, buffer, sha256: sha256(buffer), bytes: buffer.byteLength });
  }
  // Cursor snapshot for the transcript, same verbatim-carry contract as Codex.
  // Without a complete snapshot the importer cannot mark the prefix as already
  // read, and the other device would double-count the whole conversation.
  const store = await openCursorStore({ trackerDir });
  const entry = store.cursors?.files?.[item.absPath] || null;
  if (!entry || Number(entry.lastLine || 0) <= 0) {
    const error = new Error("antigravity transcript not yet collected; retry after the next collection");
    error.code = "SESSION_SYNC_SCAN_PENDING";
    throw error;
  }
  const lineCount = await countLines(item.absPath);
  if (lineCount != null && Number(entry.lastLine) !== lineCount) {
    const error = new Error("antigravity transcript has unscanned changes; retry after the next collection");
    error.code = "SESSION_SYNC_SCAN_PENDING";
    throw error;
  }
  const cursor = { [item.absPath]: entry };
  return {
    meta: {
      title: item.title,
      cwd: null,
      project: null,
      cursor: { [item.absPath]: entry },
      extra: { antigravitySessionDir: sessionId },
    },
    files,
  };
}

async function countLines(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const chunk = 1 * 1024 * 1024;
    let remaining = size;
    let position = 0;
    let lines = 0;
    let tailCarriesNewline = true;
    while (remaining > 0) {
      const read = Math.min(chunk, remaining);
      const buffer = Buffer.alloc(read);
      await handle.read(buffer, 0, read, position);
      for (const byte of buffer) if (byte === 0x0a) lines += 1;
      tailCarriesNewline = buffer[read - 1] === 0x0a;
      position += read;
      remaining -= read;
    }
    return tailCarriesNewline ? lines : lines + 1;
  } finally {
    await handle.close();
  }
}

function safeJoin(root, relativeKey) {
  if (!isValidPayloadKey(relativeKey)) return null;
  const target = path.resolve(root, relativeKey);
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

async function importBundle({ home, env, trackerDir, files, meta, backupsDir, priorSha256 }) {
  const root = targetBrainRoot(home, env);
  const sessionId = meta.session_id;
  const sessionDir = safeJoin(root, sessionId);
  if (!sessionDir) {
    const error = new Error("invalid antigravity session id");
    error.code = "SESSION_SYNC_INVALID_KEY";
    throw error;
  }
  const incomingKeys = files.map((file) => file.key).sort();
  if (incomingKeys.some((key) => !key.startsWith(`${sessionId}/`))) {
    const error = new Error("antigravity bundle contains files outside the session dir");
    error.code = "SESSION_SYNC_REMOTE_INVALID";
    throw error;
  }
  // Canonical directory digest: key bytes + content, sorted by key. The same
  // formula describes the local tree and the registry's prior import state.
  const digest = canonicalDigest(files);
  const existingTranscript = safeJoin(root, `${sessionId}/.system_generated/logs/transcript.jsonl`);
  let backupPath = null;
  if (existingTranscript && statOrNull(existingTranscript)) {
    const localFiles = await walkTree(sessionDir, { maxFiles: 2000 }).catch(() => []);
    const localKeys = localFiles.map((file) => `${sessionId}/${file.key}`).sort();
    const identical = localKeys.length === incomingKeys.length && localKeys.every((key, index) => key === incomingKeys[index])
      ? await filesAreIdentical(sessionDir, files)
      : false;
    if (identical) {
      // Same content already present; cursor refresh below still applies.
    } else {
      const hasLocalOnly = localKeys.some((key) => !incomingKeys.includes(key));
      if (!priorSha256 || hasLocalOnly) {
        const error = new Error("local antigravity conversation diverged from the bundle");
        error.code = hasLocalOnly ? "SESSION_SYNC_CONFLICT" : "SESSION_SYNC_LOCAL_EXISTS";
        throw error;
      }
      const localDigest = await directoryDigest(sessionDir, localFiles);
      if (localDigest !== priorSha256) {
        const error = new Error("local antigravity conversation changed since the last import");
        error.code = "SESSION_SYNC_CONFLICT";
        throw error;
      }
      backupPath = path.join(backupsDir, backupFileName(`${sessionId}-dir`));
      await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      await fs.cp(sessionDir, backupPath, { recursive: true });
    }
  }
  for (const file of files) {
    const target = safeJoin(root, file.key);
    if (!target) {
      const error = new Error(`invalid payload key: ${file.key}`);
      error.code = "SESSION_SYNC_REMOTE_INVALID";
      throw error;
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, file.buffer);
  }
  // Re-anchor the transcript cursor to the local path (path may differ across
  // machines because the brain root variant can differ).
  const cursorEntry = meta?.cursor?.[Object.keys(meta.cursor || {})[0]];
  if (cursorEntry && existingTranscript) {
    const store = await openCursorStore({ trackerDir });
    store.cursors.files = store.cursors.files || {};
    store.cursors.files[existingTranscript] = { ...cursorEntry, updatedAt: new Date().toISOString() };
    await store.commit(store.cursors);
  }
  return { localPath: sessionDir, backupPath, sha256Plain: digest, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

async function filesAreIdentical(sessionDir, files) {
  for (const file of files) {
    const target = safeJoin(sessionDir, file.key.split("/").slice(1).join("/"));
    if (!target) return false;
    const st = statOrNull(target);
    if (!st || st.size !== file.buffer.byteLength) return false;
    if ((await sha256File(target)).sha256 !== file.sha256) return false;
  }
  return true;
}

function canonicalDigest(files) {
  const sorted = [...files].sort((a, b) => a.key.localeCompare(b.key));
  return sha256(Buffer.concat(sorted.flatMap((file) => [
    Buffer.from(file.key, "utf8"),
    file.buffer,
  ])));
}

async function directoryDigest(sessionDir, localFiles) {
  const sessionId = path.basename(sessionDir);
  const entries = [];
  for (const file of localFiles) {
    entries.push({ key: `${sessionId}/${file.key}`, buffer: await fs.readFile(file.absPath) });
  }
  return canonicalDigest(entries);
}

module.exports = {
  AGENT,
  listConversations,
  findConversation,
  prepareUpload,
  importBundle,
  targetBrainRoot,
};
