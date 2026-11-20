"use strict";

// Codex adapter for the manual conversation sync.
//
// A Codex conversation is one self-contained rollout file under
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl[.zst]; the first line
// (session_meta) carries session_id/cwd/git. `codex resume` lists threads from
// ~/.codex/session_index.jsonl ({id, thread_name, updated_at} lines), so an
// import appends an index line when the id is new.
//
// Anti-double-count (SYNC_DESIGN §12.4): the upload carries the SOURCE device's
// cursor entry verbatim (offset/lastTotal/baselines/...). The importer rewrites
// it with its own inode, so the incremental scanner only counts real appends.

const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");

const { openCursorStore } = require("../../cursor-store");
const {
  sha256,
  sha256File,
  isValidPayloadKey,
  backupFileName,
  nowIso,
  statOrNull,
} = require("../common");

const AGENT = "codex";

function codexHome(home) {
  return path.join(home, ".codex");
}

function sessionsRoot(home) {
  return path.join(codexHome(home), "sessions");
}

function sessionIndexPath(home) {
  return path.join(codexHome(home), "session_index.jsonl");
}

// rollout-2026-11-14T10-14-43-01a1d7d5-eb1c-7e70-92db-34aad737c4b5.jsonl(.zst)
const ROLLOUT_NAME_RE = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\.zst)?\.jsonl(?:\.zst)?$/;

function sessionIdFromFileName(fileName) {
  const match = ROLLOUT_NAME_RE.exec(fileName);
  return match ? match[1] : null;
}

function safeJoinCodex(home, relativeKey) {
  if (!isValidPayloadKey(relativeKey)) return null;
  if (!relativeKey.startsWith("sessions/")) return null;
  const target = path.resolve(codexHome(home), relativeKey);
  const root = path.resolve(codexHome(home));
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

async function listConversations({ home }) {
  const root = sessionsRoot(home);
  const out = [];
  let dateDirs = [];
  try {
    dateDirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (error && error.code === "ENOENT") return out;
    throw error;
  }
  for (const year of dateDirs) {
    let months = [];
    try {
      months = await fs.readdir(path.join(root, year), { withFileTypes: true });
    } catch { continue; }
    for (const monthEntry of months) {
      if (!monthEntry.isDirectory()) continue;
      let days = [];
      try {
        days = await fs.readdir(path.join(root, year, monthEntry.name), { withFileTypes: true });
      } catch { continue; }
      for (const dayEntry of days) {
        if (!dayEntry.isDirectory()) continue;
        let files = [];
        const dayPath = path.join(root, year, monthEntry.name, dayEntry.name);
        try {
          files = await fs.readdir(dayPath, { withFileTypes: true });
        } catch { continue; }
        for (const file of files) {
          if (!file.isFile()) continue;
          const sessionId = sessionIdFromFileName(file.name);
          if (!sessionId) continue;
          const absPath = path.join(dayPath, file.name);
          const st = statOrNull(absPath);
          if (!st) continue;
          out.push({
            agent: AGENT,
            sessionId,
            absPath,
            relativeKey: path.relative(codexHome(home), absPath).split(path.sep).join("/"),
            bytes: st.size,
            updatedAtMs: st.mtimeMs,
            title: null,
            cwd: null,
            project: null,
          });
        }
      }
    }
  }
  await decorateTitlesAndMeta(home, out);
  out.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return out;
}

// Titles live in session_index.jsonl; cwd/git live in the rollout's first line.
async function decorateTitlesAndMeta(home, items) {
  const titles = new Map();
  try {
    const raw = await fs.readFile(sessionIndexPath(home), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.id === "string" && typeof parsed.thread_name === "string") {
          titles.set(parsed.id, parsed.thread_name);
        }
      } catch { /* tolerate torn tail lines */ }
    }
  } catch { /* no index yet */ }

  await Promise.all(items.map(async (item) => {
    item.title = titles.get(item.sessionId) || null;
    const meta = await readSessionMeta(item.absPath).catch(() => null);
    if (meta) {
      item.cwd = meta.cwd || null;
      item.project = meta.project || null;
      if (!item.title) item.title = meta.firstUserMessage || null;
    }
  }));
}

// Read only the head of the file: session_meta is the first line, and a
// heuristic first user message may follow. Never loads the whole rollout.
async function readSessionMeta(absPath, { maxBytes = 256 * 1024 } = {}) {
  const handle = await fs.open(absPath, "r");
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, maxBytes));
    await handle.read(head, 0, head.byteLength, 0);
    const text = head.toString("utf8");
    let sessionMeta = null;
    let firstUserMessage = null;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch { continue; }
      if (!sessionMeta && parsed?.type === "session_meta" && parsed?.payload) {
        sessionMeta = parsed.payload;
      }
      if (!firstUserMessage && parsed?.type === "event_msg" && parsed?.payload?.type === "user_message") {
        const message = parsed.payload.message || parsed.payload.text || "";
        if (typeof message === "string" && message.trim()) {
          firstUserMessage = message.trim().slice(0, 120);
        }
      }
      if (sessionMeta && firstUserMessage) break;
      if (parsed?.type !== "session_meta" && firstUserMessage) break;
    }
    if (!sessionMeta) return null;
    return {
      cwd: typeof sessionMeta.cwd === "string" ? sessionMeta.cwd : null,
      project: sessionMeta?.git?.repository_url || null,
      firstUserMessage,
    };
  } finally {
    await handle.close();
  }
}

async function findConversation(home, sessionId) {
  const items = await listConversations({ home });
  return items.find((item) => item.sessionId === sessionId) || null;
}

async function readCursorEntry(trackerDir, absPath) {
  const store = await openCursorStore({ trackerDir });
  if (typeof store.loadCodexFilesForPaths === "function") {
    await store.loadCodexFilesForPaths([absPath]);
  }
  const cursors = store.cursors || {};
  return cursors.files?.[absPath] || null;
}

async function writeCursorEntry(trackerDir, absPath, entry) {
  const store = await openCursorStore({ trackerDir });
  if (typeof store.loadCodexFilesForPaths === "function") {
    await store.loadCodexFilesForPaths([absPath]);
  }
  const st = statOrNull(absPath);
  const inode = st ? (st.ino || 0) : 0;
  store.cursors.files = store.cursors.files || {};
  store.cursors.files[absPath] = { ...entry, inode, updatedAt: nowIso() };
  await store.commit(store.cursors);
}

async function prepareUpload({ home, trackerDir, sessionId }) {
  const item = await findConversation(home, sessionId);
  if (!item) {
    const error = new Error("codex session not found");
    error.code = "SESSION_SYNC_LOCAL_MISSING";
    throw error;
  }
  const st = statOrNull(item.absPath);
  if (!st) {
    const error = new Error("codex session file disappeared");
    error.code = "SESSION_SYNC_LOCAL_MISSING";
    throw error;
  }
  const cursor = await readCursorEntry(trackerDir, item.absPath);
  if (!cursor || Number(cursor.offset || 0) !== st.size) {
    // The usage scanner has not caught up with the file yet. Uploading a stale
    // prefix snapshot would mis-attribute the unscanned tail twice once the
    // conversation continues on the other device.
    const error = new Error("codex session has unscanned changes; retry after the next collection");
    error.code = "SESSION_SYNC_SCAN_PENDING";
    throw error;
  }
  const buffer = await fs.readFile(item.absPath);
  const digest = sha256(buffer);
  return {
    meta: {
      title: item.title,
      cwd: item.cwd,
      project: item.project,
      cursor: { [item.relativeKey]: cursor },
      extra: { codexRelativePath: item.relativeKey },
    },
    files: [{ key: item.relativeKey, buffer, sha256: digest, bytes: buffer.byteLength }],
  };
}

async function importBundle({ home, trackerDir, files, meta, backupsDir, priorSha256 }) {
  const relativeKey = meta?.extra?.codexRelativePath || files[0]?.key;
  const target = safeJoinCodex(home, relativeKey);
  if (!target) {
    const error = new Error("refusing codex payload outside the sessions tree");
    error.code = "SESSION_SYNC_INVALID_KEY";
    throw error;
  }
  const file = files.find((candidate) => candidate.key === relativeKey);
  if (!file) {
    const error = new Error("codex bundle missing rollout payload");
    error.code = "SESSION_SYNC_REMOTE_INVALID";
    throw error;
  }
  const digest = sha256(file.buffer);
  const existing = statOrNull(target);
  let backupPath = null;
  if (existing) {
    const existingDigest = (await sha256File(target)).sha256;
    if (existingDigest === digest) {
      // Already identical on disk; still refresh index/cursor below.
    } else if (priorSha256 && existingDigest === priorSha256) {
      backupPath = path.join(backupsDir, backupFileName(relativeKey));
      await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      await fs.copyFile(target, backupPath);
      await fs.writeFile(target, file.buffer);
    } else {
      const error = new Error("local codex session diverged from the last import");
      error.code = "SESSION_SYNC_CONFLICT";
      throw error;
    }
  } else {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, file.buffer);
  }

  await appendSessionIndexIfMissing(home, meta.session_id, meta.title);

  const cursorEntry = meta?.cursor?.[relativeKey];
  if (cursorEntry && typeof cursorEntry === "object") {
    await writeCursorEntry(trackerDir, target, cursorEntry);
  }
  return { localPath: target, backupPath, sha256Plain: digest, bytes: file.buffer.byteLength };
}

async function appendSessionIndexIfMissing(home, sessionId, title) {
  const indexPath = sessionIndexPath(home);
  let raw = "";
  try {
    raw = await fs.readFile(indexPath, "utf8");
  } catch { /* first import on this machine */ }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.id === sessionId) return;
    } catch { /* tolerate torn tail lines */ }
  }
  const threadName = (typeof title === "string" && title.trim())
    ? title.trim().slice(0, 200)
    : "";
  const lineJson = JSON.stringify({ id: sessionId, thread_name: threadName, updated_at: nowIso() });
  // Codex guards the index with session_index.jsonl.lock; appendFile is a
  // single small append-mode write, which keeps line appends atomic even when
  // Codex is writing concurrently.
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.appendFile(indexPath, `${lineJson}\n`, "utf8");
}

module.exports = {
  AGENT,
  listConversations,
  findConversation,
  prepareUpload,
  importBundle,
  readCursorEntry,
  sessionIdFromFileName,
};
