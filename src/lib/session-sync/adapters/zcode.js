"use strict";

// ZCode adapter for the manual conversation sync.
//
// ZCode's authoritative conversation store is the opencode-family SQLite db
// at ~/.zcode/cli/db/db.sqlite (session/session_v2 + session_message or the
// legacy message table, plus model_usage). A bundle carries the session row
// and its message rows — never model_usage: appended usage is written by ZCode
// itself as new native rows on this device, and imported message ids are
// registered so the usage scanner never re-counts them (SYNC_DESIGN §12.4).

const fssync = require("node:fs");
const path = require("node:path");

const { resolveZcodeNativeDbPath } = require("../../install-resolver");
const { readSqliteJsonRows } = require("../../sqlite-reader");
const {
  sha256,
} = require("../common");

const AGENT = "zcode";
const SUBAGENT_ID_RE = /subagent/i;

function resolveDbPath({ home, env = process.env }) {
  return resolveZcodeNativeDbPath({ home, env });
}

// v2 layout stores messages in session_message joined against session_v2;
// legacy installs keep a flat message table against session. Both keep the
// same row shape, so the bundle only records which table the rows came from.
function detectLayout(dbPath) {
  const tables = readSqliteJsonRows(dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session','session_v2','session_message','message')",
    { preferNode: true, label: "zcode" });
  const names = new Set(tables.map((row) => row.name));
  if (names.has("session_v2") && names.has("session_message")) return "v2";
  if (names.has("session") && names.has("message")) return "v1";
  if (names.has("session") && names.has("session_message")) return "v2-flat";
  return null;
}

function sessionTableFor(layout) {
  return layout === "v2" ? "session_v2" : "session";
}

function messageTableFor(layout) {
  return layout === "v1" ? "message" : "session_message";
}

function sessionRowToListing(row) {
  if (!row || typeof row.id !== "string") return null;
  const updatedMs = Number(row.time_updated || row.updated_at || row.time || 0);
  return {
    agent: AGENT,
    sessionId: row.id,
    absPath: null,
    title: typeof row.title === "string" && row.title.trim() ? row.title.trim().slice(0, 200) : null,
    cwd: typeof row.directory === "string" ? row.directory : null,
    project: null,
    bytes: 0,
    updatedAtMs: Number.isFinite(updatedMs) && updatedMs > 0 ? updatedMs : null,
    messageCount: null,
  };
}

function listConversations({ home, env }) {
  const dbPath = resolveDbPath({ home, env });
  if (!dbPath || !fssync.existsSync(dbPath)) return [];
  const layout = detectLayout(dbPath);
  if (!layout) return [];
  const rows = readSqliteJsonRows(dbPath,
    `SELECT * FROM ${sessionTableFor(layout)}`,
    { preferNode: true, label: "zcode", timeout: 30_000 });
  const out = [];
  for (const row of rows) {
    if (SUBAGENT_ID_RE.test(String(row.id || ""))) continue;
    const listing = sessionRowToListing(row);
    if (listing) out.push(listing);
  }
  out.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
  return out;
}

function readSessionRow(dbPath, layout, sessionId) {
  const rows = readSqliteJsonRows(dbPath,
    `SELECT * FROM ${sessionTableFor(layout)} WHERE id = '${sessionId.replace(/'/g, "''")}'`,
    { preferNode: true, label: "zcode" });
  return rows[0] || null;
}

function readMessageRows(dbPath, layout, sessionId) {
  return readSqliteJsonRows(dbPath,
    `SELECT * FROM ${messageTableFor(layout)} WHERE session_id = '${sessionId.replace(/'/g, "''")}' ORDER BY rowid ASC`,
    { preferNode: true, label: "zcode", timeout: 60_000, maxBuffer: 200 * 1024 * 1024 });
}

function messageRowsToLines(rows) {
  // message.data is a JSON string in some schema versions; sqlite -json keeps
  // strings as-is, node:sqlite returns strings too. Preserve verbatim.
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function parseMessageLines(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed));
  }
  return out;
}

function prepareUpload({ home, env, sessionId }) {
  const dbPath = resolveDbPath({ home, env });
  if (!dbPath || !fssync.existsSync(dbPath)) {
    const error = new Error("zcode database not found");
    error.code = "SESSION_SYNC_LOCAL_MISSING";
    throw error;
  }
  const layout = detectLayout(dbPath);
  if (!layout) {
    const error = new Error("zcode database schema not recognized");
    error.code = "SESSION_SYNC_LOCAL_MISSING";
    throw error;
  }
  const sessionRow = readSessionRow(dbPath, layout, sessionId);
  if (!sessionRow) {
    const error = new Error("zcode session not found");
    error.code = "SESSION_SYNC_LOCAL_MISSING";
    throw error;
  }
  const messageRows = readMessageRows(dbPath, layout, sessionId);
  const listing = sessionRowToListing(sessionRow);
  const sessionJson = Buffer.from(JSON.stringify({ layout, session_row: sessionRow }, null, 1), "utf8");
  const messagesJsonl = Buffer.from(messageRowsToLines(messageRows), "utf8");
  const title = listing.title || deriveTitleFromMessages(messageRows);
  return {
    meta: {
      title,
      cwd: listing.cwd,
      project: null,
      cursor: null,
      extra: { zcodeLayout: layout },
    },
    files: [
      { key: "session.json", buffer: sessionJson, sha256: sha256(sessionJson), bytes: sessionJson.byteLength },
      { key: "messages.jsonl", buffer: messagesJsonl, sha256: sha256(messagesJsonl), bytes: messagesJsonl.byteLength },
    ],
    messageIds: messageRows.map((row) => String(row.id || "")).filter(Boolean),
  };
}

function deriveTitleFromMessages(rows) {
  for (const row of rows) {
    let data = row?.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch { data = null; }
    }
    const role = data?.role || row?.role;
    if (role !== "user" && role !== "human") continue;
    const parts = Array.isArray(data?.parts) ? data.parts : [];
    for (const part of parts) {
      const text = part?.text || (typeof part === "string" ? part : "");
      if (typeof text === "string" && text.trim()) return text.trim().slice(0, 120);
    }
  }
  return null;
}

// Import into the local ZCode db. Merge rule (SYNC_DESIGN §12.3): local
// message ids must be a subset of the incoming ids — INSERT OR IGNORE then
// adds exactly the other device's continuation without ever deleting local
// rows. A true divergence (both sides wrote unseen messages) is refused.
function importBundle({ home, env, files, meta, priorImport }) {
  const dbPath = resolveDbPath({ home, env });
  if (!dbPath || !fssync.existsSync(dbPath)) {
    const error = new Error("zcode database not found");
    error.code = "SESSION_SYNC_LOCAL_MISSING";
    throw error;
  }
  const layout = detectLayout(dbPath);
  const bundleLayout = meta?.extra?.zcodeLayout;
  if (!layout || layout !== bundleLayout) {
    const error = new Error(`zcode layout mismatch (local ${layout || "unknown"}, bundle ${bundleLayout || "unknown"})`);
    error.code = "SESSION_SYNC_LAYOUT_MISMATCH";
    throw error;
  }
  const sessionFile = files.find((file) => file.key === "session.json");
  const messagesFile = files.find((file) => file.key === "messages.jsonl");
  if (!sessionFile || !messagesFile) {
    const error = new Error("zcode bundle missing session or messages payload");
    error.code = "SESSION_SYNC_REMOTE_INVALID";
    throw error;
  }
  let sessionPayload;
  let incomingRows;
  try {
    sessionPayload = JSON.parse(sessionFile.buffer.toString("utf8"));
    incomingRows = parseMessageLines(messagesFile.buffer.toString("utf8"));
  } catch {
    const error = new Error("zcode bundle payload is not valid JSON");
    error.code = "SESSION_SYNC_REMOTE_INVALID";
    throw error;
  }
  if (!sessionPayload?.session_row || sessionPayload.session_row.id !== meta.session_id) {
    const error = new Error("zcode bundle session id mismatch");
    error.code = "SESSION_SYNC_REMOTE_INVALID";
    throw error;
  }

  let nodeSqlite;
  try {
    nodeSqlite = require("node:sqlite");
  } catch {
    const error = new Error("node:sqlite unavailable for zcode import");
    error.code = "SESSION_SYNC_SQLITE_UNAVAILABLE";
    throw error;
  }
  const { DatabaseSync } = nodeSqlite;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const sessionTable = sessionTableFor(layout);
    const messageTable = messageTableFor(layout);

    const sessionColumns = tableColumns(db, sessionTable);
    const messageColumns = tableColumns(db, messageTable);

    const existingSession = db.prepare(
      `SELECT id FROM ${sessionTable} WHERE id = ?`).get(meta.session_id);
    let insertedIds = [];
    if (existingSession) {
      const localIds = new Set(
        db.prepare(`SELECT id FROM ${messageTable} WHERE session_id = ?`)
          .all(meta.session_id)
          .map((row) => String(row.id || "")));
      const incomingIds = new Set(incomingRows.map((row) => String(row.id || "")).filter(Boolean));
      for (const localId of localIds) {
        if (localId && !incomingIds.has(localId)) {
          const error = new Error("local zcode conversation diverged from the bundle");
          error.code = "SESSION_SYNC_CONFLICT";
          throw error;
        }
      }
      if (localIds.size === 0 && !priorImport) {
        // A local session row with no messages and no prior import is most
        // likely an unrelated local conversation with the same id.
        const error = new Error("zcode session already exists locally");
        error.code = "SESSION_SYNC_LOCAL_EXISTS";
        throw error;
      }
    }

    const insertMessage = buildInsert(db, messageTable, messageColumns, { ignore: true });
    insertedIds = [];
    db.exec("BEGIN");
    try {
      insertRow(db, sessionTable, sessionColumns, sessionPayload.session_row, { replace: true });
      for (const row of incomingRows) {
        const id = String(row.id || "");
        if (!id) continue;
        const changes = insertRowWithStatement(insertMessage.statement, insertMessage.columns, row);
        if (changes > 0) insertedIds.push(id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return {
      localPath: dbPath,
      backupPath: null,
      insertedMessageIds: insertedIds,
      sha256Plain: sha256(messagesFile.buffer),
      bytes: messagesFile.buffer.byteLength,
    };
  } finally {
    db.close();
  }
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .map((row) => String(row.name));
}

function buildInsert(db, table, columns, { ignore = false } = {}) {
  const usable = columns.filter((column) => column.toLowerCase() !== "rowid");
  const placeholders = usable.map(() => "?").join(", ");
  const verb = ignore ? "INSERT OR IGNORE" : "INSERT OR REPLACE";
  return {
    statement: db.prepare(`${verb} INTO ${table} (${usable.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`),
    columns: usable,
  };
}

function insertRowWithStatement(statement, columns, row) {
  const values = columns.map((column) => normalizeSqliteValue(row[column]));
  const info = statement.run(...values);
  return Number(info?.changes || 0);
}

function insertRow(db, table, columns, row, { replace = false } = {}) {
  const insert = buildInsert(db, table, columns, { ignore: !replace });
  return insertRowWithStatement(insert.statement, insert.columns, row);
}

function normalizeSqliteValue(value) {
  if (value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  return value;
}

module.exports = {
  AGENT,
  resolveDbPath,
  detectLayout,
  listConversations,
  prepareUpload,
  importBundle,
  messageRowsToLines,
  parseMessageLines,
  deriveTitleFromMessages,
};
