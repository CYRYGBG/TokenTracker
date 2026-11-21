// session-sync: manual cross-device conversation sync (docs/fork/SYNC_DESIGN.md §12).
// Covers the remote layout roundtrip, the local registry, the three agent
// adapters, and the two-device upload→import→continue→upload-again relay
// against a binary-safe in-memory WebDAV server. No real network, no real
// agent stores — everything runs in fixture temp dirs.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { gzipBuffer, sha256 } = require("../src/lib/session-sync/common");
const remote = require("../src/lib/session-sync/remote");
const store = require("../src/lib/session-sync/store");
const { createSessionSyncManager } = require("../src/lib/session-sync");
const codexAdapter = require("../src/lib/session-sync/adapters/codex");
const zcodeAdapter = require("../src/lib/session-sync/adapters/zcode");
const antigravityAdapter = require("../src/lib/session-sync/adapters/antigravity");

// ---------------------------------------------------------------------------
// Binary-safe in-memory WebDAV server (the shared webdav-client fixture
// concatenates bodies as UTF-8 strings, which would corrupt gzip payloads).
// ---------------------------------------------------------------------------

function createBinaryWebDavServer() {
  const state = {
    collections: new Set(["/"]),
    files: new Map(),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = decodeURIComponent(url.pathname);
    const auth = req.headers.authorization || "";
    if (auth !== `Basic ${Buffer.from("user:app-password").toString("base64")}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(200, { DAV: "1, 2", Allow: "OPTIONS, GET, PUT, PROPFIND, MKCOL, MOVE, DELETE" });
      res.end();
      return;
    }
    if (req.method === "MKCOL") {
      if (state.collections.has(p) || state.files.has(p)) { res.writeHead(405); res.end(); return; }
      state.collections.add(p);
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        state.files.set(p, Buffer.concat(chunks));
        res.writeHead(201);
        res.end();
      });
      return;
    }
    if (req.method === "GET") {
      const file = state.files.get(p);
      if (file == null) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(file);
      return;
    }
    if (req.method === "MOVE") {
      const destination = decodeURIComponent(new URL(req.headers.destination, "http://127.0.0.1").pathname);
      const body = state.files.get(p);
      if (body == null) { res.writeHead(404); res.end(); return; }
      if (state.files.has(destination)) { res.writeHead(412); res.end(); return; }
      state.files.set(destination, body);
      state.files.delete(p);
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      const had = state.files.delete(p) || state.collections.delete(p);
      for (const key of [...state.files.keys()]) {
        if (key.startsWith(`${p}/`)) state.files.delete(key);
      }
      for (const key of [...state.collections]) {
        if (key.startsWith(`${p}/`)) state.collections.delete(key);
      }
      res.writeHead(had ? 204 : 404);
      res.end();
      return;
    }
    if (req.method === "PROPFIND") {
      if (!state.collections.has(p) && !state.files.has(p)) { res.writeHead(404); res.end(); return; }
      const children = new Set();
      for (const entry of [...state.collections, ...state.files.keys()]) {
        if (entry === p || !entry.startsWith(`${p === "/" ? "/" : `${p}/`}`)) continue;
        const rest = entry.slice(p === "/" ? 1 : p.length + 1);
        const first = rest.split("/")[0];
        if (first) children.add(`${p === "/" ? "" : p}/${first}`);
      }
      const rows = [p, ...children].map((href) => {
        const isCollection = state.collections.has(href);
        const file = state.files.get(href);
        const encoded = href.split("/").map(encodeURIComponent).join("/");
        return (
          `<D:response><D:href>${encoded}${isCollection ? "/" : ""}</D:href>` +
          `<D:propstat><D:prop>` +
          (isCollection ? `<D:resourcetype><D:collection/></D:resourcetype>` : `<D:resourcetype/>`) +
          (file != null ? `<D:getcontentlength>${file.byteLength}</D:getcontentlength>` : "") +
          `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
        );
      });
      res.writeHead(207, { "Content-Type": "application/xml" });
      res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${rows.join("")}</D:multistatus>`);
      return;
    }
    res.writeHead(405);
    res.end();
  });
  return {
    state,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withTempDir(work) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-session-sync-"));
  try {
    return await work(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function makeManager({ trackerDir, baseUrl, machineId, home }) {
  return createSessionSyncManager({
    trackerDir,
    loadPassword: async () => "app-password",
    getConfig: async () => ({ url: baseUrl, username: "user", directory: "tt-fork", device_name: `dev-${machineId}` }),
    machineIdProvider: async () => machineId,
    homeProvider: () => home,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJob(manager, { timeoutMs = 15_000 } = {}) {
  const started = Date.now();
  for (;;) {
    const status = await manager.status();
    if (status.job && status.job.state !== "running") return status.job;
    if (Date.now() - started > timeoutMs) throw new Error("job did not finish in time");
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------
// Codex fixtures
// ---------------------------------------------------------------------------

const CODEX_SESSION_ID = "01a1d7d5-eb1c-7e70-92db-34aad737c4b5";
const CODEX_RELATIVE_KEY = "sessions/2026/11/14/rollout-2026-11-14T10-14-43-01a1d7d5-eb1c-7e70-92db-34aad737c4b5.jsonl";

function codexRolloutLine(type, payload) {
  return JSON.stringify({ timestamp: "2026-11-14T02:14:44.768Z", ordinal: 0, type, payload });
}

function codexRolloutContent({ turns = 2 } = {}) {
  const lines = [
    codexRolloutLine("session_meta", {
      session_id: CODEX_SESSION_ID,
      cwd: "D:\\work\\demo",
      git: { repository_url: "https://github.com/example/demo.git" },
    }),
    codexRolloutLine("event_msg", { type: "user_message", message: "帮我看一下这个报错是怎么回事" }),
  ];
  for (let i = 0; i < turns; i += 1) {
    lines.push(JSON.stringify({ timestamp: "2026-11-14T03:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } } }));
  }
  return `${lines.join("\n")}\n`;
}

async function writeCodexFixture(home, content, { indexEntries = [] } = {}) {
  const target = path.join(home, ".codex", CODEX_RELATIVE_KEY);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  if (indexEntries.length > 0) {
    await fs.writeFile(path.join(home, ".codex", "session_index.jsonl"),
      indexEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  }
  return target;
}

async function writeLegacyCursor(trackerDir, absPath, entry) {
  const cursorsPath = path.join(trackerDir, "cursors.json");
  let cursors = {};
  try {
    cursors = JSON.parse(await fs.readFile(cursorsPath, "utf8"));
  } catch { /* fresh */ }
  cursors.files = cursors.files || {};
  cursors.files[absPath] = entry;
  await fs.mkdir(path.dirname(cursorsPath), { recursive: true });
  await fs.writeFile(cursorsPath, JSON.stringify(cursors), "utf8");
}

function freshCursorFor(buffer) {
  return {
    inode: 1111,
    offset: Buffer.byteLength(buffer),
    lastTotal: { input_tokens: 200, output_tokens: 100, total_tokens: 300 },
    tokenUsageBaselines: [],
    lastModel: "gpt-6.1",
    modelAttributionState: null,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// ZCode fixtures
// ---------------------------------------------------------------------------

function createZcodeFixtureDb(dbPath, sessions, messages) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, time_updated INTEGER, time_created INTEGER, type TEXT, data TEXT);
    CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT, model_id TEXT, status TEXT, started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER);
  `);
  for (const session of sessions) {
    db.prepare("INSERT INTO session_v2 (id, directory, title, time_updated) VALUES (?, ?, ?, ?)")
      .run(session.id, session.directory || null, session.title || null, session.timeUpdated);
  }
  for (const message of messages) {
    db.prepare("INSERT INTO session_message (id, session_id, time_updated, time_created, type, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(message.id, message.sessionId, message.timeUpdated, message.timeCreated, message.type || "assistant",
        JSON.stringify(message.data || { role: "assistant", tokens: { input: 10, output: 5 } }));
  }
  db.close();
}

function zcodeFixtureMessages(sessionId, count, { startId = 1, startUpdated = 1_000 } = {}) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      id: `msg-${sessionId.slice(0, 8)}-${startId + i}`,
      sessionId,
      timeUpdated: startUpdated + i,
      timeCreated: startUpdated + i,
      type: i % 2 === 0 ? "assistant" : "user",
      data: { role: i % 2 === 0 ? "assistant" : "user", tokens: i % 2 === 0 ? { input: 10, output: 5 } : undefined },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Antigravity fixtures
// ---------------------------------------------------------------------------

const AG_SESSION_ID = "9f8e7d6c-5b4a-4321-8765-fedcba987654";

async function writeAntigravityFixture(home, transcriptText) {
  const sessionDir = path.join(home, ".gemini", "antigravity", "brain", AG_SESSION_ID);
  const logsDir = path.join(sessionDir, ".system_generated", "logs");
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(path.join(logsDir, "transcript.jsonl"), transcriptText, "utf8");
  await fs.writeFile(path.join(sessionDir, "memory.json"), JSON.stringify({ notes: "fixture" }), "utf8");
  return sessionDir;
}

function antigravityTranscript(turns = 2) {
  const lines = [
    JSON.stringify({ type: "USER_INPUT", content: "检查一下构建失败的原因" }),
  ];
  for (let i = 0; i < turns; i += 1) {
    lines.push(JSON.stringify({ type: "PLANNER_RESPONSE", step_index: i, content: "ok" }));
  }
  return `${lines.join("\n")}\n`;
}

function agCursorFor(lineCount) {
  return {
    cursorVersion: 3,
    lastLine: lineCount,
    contextTokens: 1200,
    previousContextTokens: 800,
    currentModel: "gemini-3-pro",
    usageSource: "transcript",
    contributions: {},
    updatedAt: new Date().toISOString(),
  };
}

async function countLinesQuick(file) {
  const text = await fs.readFile(file, "utf8");
  let lines = 0;
  for (const char of text) if (char === "\n") lines += 1;
  return text.endsWith("\n") ? lines : lines + 1;
}

// ---------------------------------------------------------------------------
// Tests: common + store
// ---------------------------------------------------------------------------

test("session-sync store: registry roundtrip and imported message id dedupe", async () => {
  await withTempDir(async (dir) => {
    const trackerDir = path.join(dir, "tracker");
    await store.recordUpload(trackerDir, "codex", "abc", { revision: 1, sha256Plain: "x", title: "t" });
    await store.recordImport(trackerDir, "zcode", "def", { revision: 2, originDevice: "other" });
    let registry = await store.readRegistry(trackerDir);
    assert.equal(registry.uploaded["codex:abc"].revision, 1);
    assert.equal(registry.uploaded["codex:abc"].title, "t");
    assert.ok(registry.uploaded["codex:abc"].uploadedAt);
    assert.equal(registry.imported["zcode:def"].originDevice, "other");

    await store.appendImportedMessageIds(trackerDir, ["m1", "m2"]);
    await store.appendImportedMessageIds(trackerDir, ["m2", "m3"]);
    const ids = await store.readImportedMessageIds(trackerDir);
    assert.deepEqual([...ids].sort(), ["m1", "m2", "m3"]);
    registry = await store.readRegistry(trackerDir);
    assert.equal(registry.uploaded["codex:abc"].revision, 1, "id append must not clobber the registry");
  });
});

test("session-sync remote: bundle roundtrip, index visibility, delete", async () => {
  await withTempDir(async (dir) => {
    const server = createBinaryWebDavServer();
    const baseUrl = await server.listen();
    try {
      const client = remote.createClient({ config: { url: baseUrl, username: "user" }, password: "app-password" });
      const buffer = Buffer.from("hello conversation\n", "utf8");
      const files = [{ key: "sessions/2026/11/14/rollout-x.jsonl", buffer, sha256: sha256(buffer), bytes: buffer.byteLength }];
      await remote.uploadBundle(client, {
        directory: "tt-fork",
        machineId: "deviceA",
        agent: "codex",
        sessionId: "sess1",
        meta: { title: "t1", cwd: "/w", project: null, revision: 1, device: { name: "A", platform: "darwin" }, cursor: { k: { offset: 1 } } },
        files,
        summaries: [{ agent: "codex", session_id: "sess1", title: "t1", revision: 1 }],
      });
      const bundle = await remote.fetchBundle(client, { directory: "tt-fork", machineId: "deviceA", agent: "codex", sessionId: "sess1" });
      assert.equal(bundle.meta.title, "t1");
      assert.equal(bundle.files[0].buffer.toString("utf8"), "hello conversation\n");
      assert.equal(bundle.files[0].key, "sessions/2026/11/14/rollout-x.jsonl");
      assert.deepEqual(bundle.meta.cursor, { k: { offset: 1 } });

      const { devices } = await remote.fetchRemoteIndexes(client, { directory: "tt-fork", ownMachineId: "deviceB" });
      assert.equal(devices.deviceA.name, "A");
      assert.equal(devices.deviceA.sessions.length, 1);
      assert.equal(devices.deviceA.sessions[0].session_id, "sess1");

      const own = await remote.fetchRemoteIndexes(client, { directory: "tt-fork", ownMachineId: "deviceA" });
      assert.deepEqual(own.devices, {}, "own device must be skipped");

      await remote.deleteBundle(client, {
        directory: "tt-fork", machineId: "deviceA", agent: "codex", sessionId: "sess1", summaries: [],
      });
      const after = await remote.fetchRemoteIndexes(client, { directory: "tt-fork", ownMachineId: "deviceB" });
      assert.equal(after.devices.deviceA.sessions.length, 0);
      await assert.rejects(
        () => remote.fetchBundle(client, { directory: "tt-fork", machineId: "deviceA", agent: "codex", sessionId: "sess1" }),
        (error) => error.code === "SESSION_SYNC_REMOTE_MISSING",
      );
    } finally {
      await server.close();
    }
  });
});

test("session-sync remote: gzip survives the wire byte-for-byte", async () => {
  await withTempDir(async (dir) => {
    const server = createBinaryWebDavServer();
    const baseUrl = await server.listen();
    try {
      const client = remote.createClient({ config: { url: baseUrl, username: "user" }, password: "app-password" });
      const binary = Buffer.concat([Buffer.from([0x1f, 0x8b, 0xff, 0x00, 0xfe]), cryptoRandom(2048)]);
      const files = [{ key: "blob.bin", buffer: binary, sha256: sha256(binary), bytes: binary.byteLength }];
      await remote.uploadBundle(client, {
        directory: "tt-fork", machineId: "deviceA", agent: "antigravity", sessionId: "sess9",
        meta: { title: null, revision: 1, device: { name: "A" } }, files, summaries: [],
      });
      const bundle = await remote.fetchBundle(client, { directory: "tt-fork", machineId: "deviceA", agent: "antigravity", sessionId: "sess9" });
      assert.equal(sha256(bundle.files[0].buffer), sha256(binary));
    } finally {
      await server.close();
    }
  });
});

function cryptoRandom(bytes) {
  return require("node:crypto").randomBytes(bytes);
}

// ---------------------------------------------------------------------------
// Tests: codex adapter
// ---------------------------------------------------------------------------

test("session-sync codex adapter: list, upload bundle carries cursor, import rewrites inode + index", async () => {
  await withTempDir(async (dir) => {
    const homeA = path.join(dir, "homeA");
    const homeB = path.join(dir, "homeB");
    const trackerA = path.join(dir, "trackerA");
    const trackerB = path.join(dir, "trackerB");

    const content = codexRolloutContent();
    const absPath = await writeCodexFixture(homeA, content, {
      indexEntries: [{ id: CODEX_SESSION_ID, thread_name: "已有标题", updated_at: "2026-11-14T02:14:44.000Z" }],
    });
    await writeLegacyCursor(trackerA, absPath, freshCursorFor(content));

    const items = await codexAdapter.listConversations({ home: homeA });
    assert.equal(items.length, 1);
    assert.equal(items[0].sessionId, CODEX_SESSION_ID);
    assert.equal(items[0].title, "已有标题");
    assert.equal(items[0].cwd, "D:\\work\\demo");
    assert.equal(items[0].project, "https://github.com/example/demo.git");

    const prepared = await codexAdapter.prepareUpload({ home: homeA, trackerDir: trackerA, sessionId: CODEX_SESSION_ID });
    assert.equal(prepared.files.length, 1);
    assert.equal(prepared.files[0].key, CODEX_RELATIVE_KEY);
    assert.deepEqual(prepared.meta.cursor[CODEX_RELATIVE_KEY].lastTotal, { input_tokens: 200, output_tokens: 100, total_tokens: 300 });

    // Import into a second machine's home.
    const backupsDir = path.join(trackerB, "session-sync", "backups");
    const result = await codexAdapter.importBundle({
      home: homeB, trackerDir: trackerB, files: prepared.files, meta: {
        session_id: CODEX_SESSION_ID,
        title: "已有标题",
        extra: { codexRelativePath: CODEX_RELATIVE_KEY },
        cursor: prepared.meta.cursor,
      }, backupsDir, priorSha256: null,
    });
    const importedPath = path.join(homeB, ".codex", CODEX_RELATIVE_KEY);
    assert.equal(result.localPath, importedPath);
    assert.equal((await fs.readFile(importedPath, "utf8")), content);

    const indexB = (await fs.readFile(path.join(homeB, ".codex", "session_index.jsonl"), "utf8")).trim().split("\n");
    assert.equal(indexB.length, 1);
    const parsedIndex = JSON.parse(indexB[0]);
    assert.equal(parsedIndex.id, CODEX_SESSION_ID);
    assert.equal(parsedIndex.thread_name, "已有标题");

    const cursorsB = JSON.parse(await fs.readFile(path.join(trackerB, "cursors.json"), "utf8"));
    const importedCursor = cursorsB.files[importedPath];
    assert.ok(importedCursor, "cursor written under the local path");
    const localInode = fssync.statSync(importedPath).ino;
    assert.equal(importedCursor.inode, localInode, "inode re-anchored to the local file");
    assert.equal(importedCursor.offset, Buffer.byteLength(content));
    assert.deepEqual(importedCursor.lastTotal, { input_tokens: 200, output_tokens: 100, total_tokens: 300 });

    // Re-import identical content: no-op success (idempotent).
    await codexAdapter.importBundle({
      home: homeB, trackerDir: trackerB, files: prepared.files, meta: {
        session_id: CODEX_SESSION_ID, extra: { codexRelativePath: CODEX_RELATIVE_KEY }, cursor: prepared.meta.cursor,
      }, backupsDir, priorSha256: result.sha256Plain,
    });
  });
});

test("session-sync codex adapter: stale cursor refuses upload; divergence refuses import; replace backs up", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const tracker = path.join(dir, "tracker");
    const content = codexRolloutContent();
    const absPath = await writeCodexFixture(home, content);

    // No cursor at all → refuse (scanner has not seen the file).
    await assert.rejects(
      () => codexAdapter.prepareUpload({ home, trackerDir: tracker, sessionId: CODEX_SESSION_ID }),
      (error) => error.code === "SESSION_SYNC_SCAN_PENDING",
    );

    // Stale cursor (offset < size) → refuse.
    await writeLegacyCursor(tracker, absPath, { ...freshCursorFor(content), offset: 5 });
    await assert.rejects(
      () => codexAdapter.prepareUpload({ home, trackerDir: tracker, sessionId: CODEX_SESSION_ID }),
      (error) => error.code === "SESSION_SYNC_SCAN_PENDING",
    );

    // Fresh cursor → ok.
    await writeLegacyCursor(tracker, absPath, freshCursorFor(content));
    const prepared = await codexAdapter.prepareUpload({ home, trackerDir: tracker, sessionId: CODEX_SESSION_ID });
    const backupsDir = path.join(tracker, "backups");
    await fs.mkdir(backupsDir, { recursive: true });

    const meta = { session_id: CODEX_SESSION_ID, extra: { codexRelativePath: CODEX_RELATIVE_KEY }, cursor: prepared.meta.cursor };
    const first = await codexAdapter.importBundle({ home, trackerDir: tracker, files: prepared.files, meta, backupsDir, priorSha256: null });
    assert.equal(first.backupPath, null, "identical content needs no backup");

    // Diverged local (no prior import record) → conflict.
    const diverged = Buffer.from(codexRolloutContent({ turns: 3 }));
    await fs.writeFile(absPath, diverged, "utf8");
    await assert.rejects(
      () => codexAdapter.importBundle({ home, trackerDir: tracker, files: prepared.files, meta, backupsDir, priorSha256: null }),
      (error) => error.code === "SESSION_SYNC_CONFLICT",
    );

    // Local unchanged since the last import + a NEW revision arrives → the
    // local copy is backed up and replaced by the bundle content.
    await fs.writeFile(absPath, content, "utf8");
    const revisedContent = codexRolloutContent({ turns: 5 });
    const revisedBuffer = Buffer.from(revisedContent, "utf8");
    const revisedFiles = [{ key: CODEX_RELATIVE_KEY, buffer: revisedBuffer, sha256: sha256(revisedBuffer), bytes: revisedBuffer.byteLength }];
    const second = await codexAdapter.importBundle({ home, trackerDir: tracker, files: revisedFiles, meta, backupsDir, priorSha256: first.sha256Plain });
    assert.ok(second.backupPath, "replace path backs up the unchanged-since-import local copy");
    assert.ok(fssync.existsSync(second.backupPath));
    assert.equal((await fs.readFile(second.backupPath, "utf8")), content, "backup holds the previous local content");
    assert.equal((await fs.readFile(absPath, "utf8")), revisedContent, "local file replaced by the bundle content");
  });
});

// ---------------------------------------------------------------------------
// Tests: zcode adapter
// ---------------------------------------------------------------------------

test("session-sync zcode adapter: export/import roundtrip, prefix merge, divergence refusal", async () => {
  await withTempDir(async (dir) => {
    const homeA = path.join(dir, "homeA");
    const homeB = path.join(dir, "homeB");
    const dbA = path.join(homeA, ".zcode", "cli", "db", "db.sqlite");
    const dbB = path.join(homeB, ".zcode", "cli", "db", "db.sqlite");
    await fs.mkdir(path.dirname(dbA), { recursive: true });
    await fs.mkdir(path.dirname(dbB), { recursive: true });

    const sessionId = "sess-zc-0001";
    createZcodeFixtureDb(dbA,
      [{ id: sessionId, directory: "/home/dev/project", title: "调试构建", timeUpdated: 2_000 }],
      zcodeFixtureMessages(sessionId, 4));
    createZcodeFixtureDb(dbB, [], []);

    const items = zcodeAdapter.listConversations({ home: homeA, env: {} });
    assert.equal(items.length, 1);
    assert.equal(items[0].sessionId, sessionId);
    assert.equal(items[0].title, "调试构建");
    assert.ok(!/subagent/i.test(items[0].sessionId));

    const prepared = zcodeAdapter.prepareUpload({ home: homeA, env: {}, sessionId });
    assert.equal(prepared.files.length, 2);
    const sessionPayload = JSON.parse(prepared.files.find((f) => f.key === "session.json").buffer.toString("utf8"));
    assert.equal(sessionPayload.layout, "v2");
    assert.equal(sessionPayload.session_row.id, sessionId);
    const messageLines = prepared.files.find((f) => f.key === "messages.jsonl").buffer.toString("utf8").trim().split("\n");
    assert.equal(messageLines.length, 4);

    // Import into B.
    const result = zcodeAdapter.importBundle({ home: homeB, env: {}, files: prepared.files, meta: { session_id: sessionId, extra: { zcodeLayout: "v2" } }, priorImport: false });
    assert.equal(result.insertedMessageIds.length, 4);
    const imported = zcodeAdapter.listConversations({ home: homeB, env: {} });
    assert.equal(imported.length, 1);
    assert.equal(imported[0].title, "调试构建");

    // B continues: append two more messages, then export from B.
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbB);
    const more = zcodeFixtureMessages(sessionId, 2, { startId: 5, startUpdated: 5_000 });
    for (const message of more) {
      db.prepare("INSERT INTO session_message (id, session_id, time_updated, time_created, type, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run(message.id, message.sessionId, message.timeUpdated, message.timeCreated, message.type, JSON.stringify(message.data));
    }
    db.close();

    const preparedB = zcodeAdapter.prepareUpload({ home: homeB, env: {}, sessionId });
    // A imports B's revision: prefix merge adds only B's messages.
    const merged = zcodeAdapter.importBundle({ home: homeA, env: {}, files: preparedB.files, meta: { session_id: sessionId, extra: { zcodeLayout: "v2" } }, priorImport: false });
    assert.equal(merged.insertedMessageIds.length, 2, "only the continuation messages are inserted on the origin device");

    // Divergence: A has a message B's bundle lacks → refuse.
    const dbA2 = new DatabaseSync(dbA);
    dbA2.prepare("INSERT INTO session_message (id, session_id, time_updated, time_created, type, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run("msg-orphan-1", sessionId, 9_000, 9_000, "assistant", JSON.stringify({ role: "assistant" }));
    dbA2.close();
    await assert.rejects(
      async () => zcodeAdapter.importBundle({ home: homeA, env: {}, files: preparedB.files, meta: { session_id: sessionId, extra: { zcodeLayout: "v2" } }, priorImport: false }),
      (error) => error.code === "SESSION_SYNC_CONFLICT",
    );

    // Layout mismatch refused.
    await assert.rejects(
      async () => zcodeAdapter.importBundle({ home: homeB, env: {}, files: prepared.files, meta: { session_id: sessionId, extra: { zcodeLayout: "v1" } }, priorImport: false }),
      (error) => error.code === "SESSION_SYNC_LAYOUT_MISMATCH",
    );
  });
});

test("session-sync zcode adapter: subagent sessions excluded from listing", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const dbPath = path.join(home, ".zcode", "cli", "db", "db.sqlite");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    createZcodeFixtureDb(dbPath, [
      { id: "sess_main", title: "main", timeUpdated: 1 },
      { id: "sess_subagent_agent_x", title: "sub", timeUpdated: 2 },
    ], []);
    const items = zcodeAdapter.listConversations({ home, env: {} });
    assert.equal(items.length, 1);
    assert.equal(items[0].sessionId, "sess_main");
  });
});

// ---------------------------------------------------------------------------
// Tests: antigravity adapter
// ---------------------------------------------------------------------------

test("session-sync antigravity adapter: export carries cursor, import lands in brain root", async () => {
  await withTempDir(async (dir) => {
    const homeA = path.join(dir, "homeA");
    const homeB = path.join(dir, "homeB");
    const trackerA = path.join(dir, "trackerA");
    const trackerB = path.join(dir, "trackerB");

    const transcript = antigravityTranscript();
    const sessionDirA = await writeAntigravityFixture(homeA, transcript);
    const transcriptPath = path.join(sessionDirA, ".system_generated", "logs", "transcript.jsonl");
    const lineCount = await countLinesQuick(transcriptPath);
    await fs.mkdir(trackerA, { recursive: true });
    await writeLegacyCursor(trackerA, transcriptPath, agCursorFor(lineCount));

    const items = await antigravityAdapter.listConversations({ home: homeA, env: {} });
    assert.equal(items.length, 1);
    assert.equal(items[0].sessionId, AG_SESSION_ID);
    assert.equal(items[0].title, "检查一下构建失败的原因");

    const prepared = await antigravityAdapter.prepareUpload({ home: homeA, env: {}, trackerDir: trackerA, sessionId: AG_SESSION_ID });
    assert.ok(prepared.files.length >= 2, "transcript + sibling files");
    assert.ok(prepared.files.some((file) => file.key.endsWith("transcript.jsonl")));
    assert.equal(prepared.meta.cursor[transcriptPath].lastLine, lineCount);

    const backupsDir = path.join(trackerB, "backups");
    const result = await antigravityAdapter.importBundle({
      home: homeB, env: {}, trackerDir: trackerB, files: prepared.files,
      meta: { session_id: AG_SESSION_ID, cursor: prepared.meta.cursor }, backupsDir, priorSha256: null,
    });
    const sessionDirB = path.join(homeB, ".gemini", "antigravity", "brain", AG_SESSION_ID);
    assert.equal(result.localPath, sessionDirB);
    assert.equal((await fs.readFile(path.join(sessionDirB, ".system_generated", "logs", "transcript.jsonl"), "utf8")), transcript);
    assert.ok(fssync.existsSync(path.join(sessionDirB, "memory.json")));

    const cursorsB = JSON.parse(await fs.readFile(path.join(trackerB, "cursors.json"), "utf8"));
    const anchored = cursorsB.files[path.join(sessionDirB, ".system_generated", "logs", "transcript.jsonl")];
    assert.equal(anchored.lastLine, lineCount, "cursor re-anchored under the local brain path");
  });
});

test("session-sync antigravity adapter: unscanned transcript refuses upload", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const tracker = path.join(dir, "tracker");
    const transcript = antigravityTranscript();
    await writeAntigravityFixture(home, transcript);
    // No cursor → refuse.
    await assert.rejects(
      () => antigravityAdapter.prepareUpload({ home, env: {}, trackerDir: tracker, sessionId: AG_SESSION_ID }),
      (error) => error.code === "SESSION_SYNC_SCAN_PENDING",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: manager two-device relay
// ---------------------------------------------------------------------------

test("session-sync manager: upload from A, refresh+import on B, continue, upload back", async () => {
  await withTempDir(async (dir) => {
    const server = createBinaryWebDavServer();
    const baseUrl = await server.listen();
    try {
      const homeA = path.join(dir, "homeA");
      const homeB = path.join(dir, "homeB");
      const trackerA = path.join(dir, "trackerA");
      const trackerB = path.join(dir, "trackerB");

      const content = codexRolloutContent();
      const absPath = await writeCodexFixture(homeA, content, {
        indexEntries: [{ id: CODEX_SESSION_ID, thread_name: "接力对话", updated_at: "2026-11-14T02:14:44.000Z" }],
      });
      await writeLegacyCursor(trackerA, absPath, freshCursorFor(content));

      const managerA = makeManager({ trackerDir: trackerA, baseUrl, machineId: "deviceA", home: homeA });
      const managerB = makeManager({ trackerDir: trackerB, baseUrl, machineId: "deviceB", home: homeB });

      // A lists local conversations and uploads.
      const localA = await managerA.listLocal();
      assert.ok(localA.items.every((item) => !item.listError),
        "no adapter may fail to list (regression: missing await on async adapters)");
      assert.equal(localA.items.filter((item) => item.agent === "codex").length, 1);
      const upload = await managerA.startUpload([{ agent: "codex", sessionId: CODEX_SESSION_ID }]);
      assert.ok(upload.ok, JSON.stringify(upload));
      const uploadJob = await waitForJob(managerA);
      assert.equal(uploadJob.state, "done");
      assert.equal(uploadJob.items[0].status, "done");
      assert.equal(uploadJob.items[0].revision, 1);

      // B refreshes the remote listing and imports.
      const refreshed = await managerB.refreshRemote();
      assert.ok(refreshed.ok);
      assert.ok(refreshed.devices.deviceA, "device A visible to B");
      const listing = await managerB.remoteListing();
      const session = listing.devices.deviceA.sessions.find((s) => s.session_id === CODEX_SESSION_ID);
      assert.ok(session, "uploaded session listed for B");
      assert.equal(session.imported, null);
      const imported = await managerB.startImport([{ device: "deviceA", agent: "codex", sessionId: CODEX_SESSION_ID }]);
      assert.ok(imported.ok);
      const importJob = await waitForJob(managerB);
      assert.equal(importJob.state, "done");
      assert.equal(importJob.items[0].status, "done");
      assert.ok(fssync.existsSync(path.join(homeB, ".codex", CODEX_RELATIVE_KEY)));

      // B's listing now annotates the imported session.
      const listingAfter = await managerB.remoteListing();
      const sessionAfter = listingAfter.devices.deviceA.sessions.find((s) => s.session_id === CODEX_SESSION_ID);
      assert.equal(sessionAfter.imported.revision, 1);

      // B continues the conversation and uploads revision 2.
      const continued = Buffer.from(content + JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "继续" } }) + "\n", "utf8");
      const pathB = path.join(homeB, ".codex", CODEX_RELATIVE_KEY);
      await fs.writeFile(pathB, continued, "utf8");
      await writeLegacyCursor(trackerB, pathB, freshCursorFor(continued));
      const uploadB = await managerB.startUpload([{ agent: "codex", sessionId: CODEX_SESSION_ID }]);
      assert.ok(uploadB.ok);
      const uploadJobB = await waitForJob(managerB);
      assert.equal(uploadJobB.items[0].revision, 1, "first upload from B is its own revision 1");

      // A imports B's revision: local file matches A's own prior content, but A
      // never imported it before — origin-device divergence must be refused
      // unless the content is identical or a prior import is on record.
      const importBack = await managerA.startImport([{ device: "deviceB", agent: "codex", sessionId: CODEX_SESSION_ID }]);
      assert.ok(importBack.ok);
      const backJob = await waitForJob(managerA);
      assert.equal(backJob.items[0].status, "error");
      assert.equal(backJob.items[0].code, "SESSION_SYNC_CONFLICT", "origin device with a diverged local copy must not be silently overwritten");
      assert.equal((await fs.readFile(absPath, "utf8")), content, "A's local file untouched");

      // Register the origin state as the import baseline, then retry: the
      // replace path backs up A's local copy and applies B's continuation.
      await store.recordImport(trackerA, "codex", CODEX_SESSION_ID, {
        agent: "codex", sessionId: CODEX_SESSION_ID, originDevice: "deviceB", revision: 0,
        sha256Plain: sha256(Buffer.from(content, "utf8")),
      });
      const retry = await managerA.startImport([{ device: "deviceB", agent: "codex", sessionId: CODEX_SESSION_ID }]);
      assert.ok(retry.ok);
      const retryJob = await waitForJob(managerA);
      assert.equal(retryJob.items[0].status, "done");
      assert.equal((await fs.readFile(absPath, "utf8")), continued.toString("utf8"));
      const registry = await store.readRegistry(trackerA);
      assert.ok(registry.imported["codex:" + CODEX_SESSION_ID].revision >= 1);
    } finally {
      await server.close();
    }
  });
});

test("session-sync manager: zcode import registers message ids for usage skipping", async () => {
  await withTempDir(async (dir) => {
    const server = createBinaryWebDavServer();
    const baseUrl = await server.listen();
    try {
      const homeA = path.join(dir, "homeA");
      const homeB = path.join(dir, "homeB");
      const trackerA = path.join(dir, "trackerA");
      const trackerB = path.join(dir, "trackerB");
      const dbA = path.join(homeA, ".zcode", "cli", "db", "db.sqlite");
      const dbB = path.join(homeB, ".zcode", "cli", "db", "db.sqlite");
      await fs.mkdir(path.dirname(dbA), { recursive: true });
      await fs.mkdir(path.dirname(dbB), { recursive: true });
      const sessionId = "sess-zc-relay";
      createZcodeFixtureDb(dbA,
        [{ id: sessionId, directory: "/w", title: "接力", timeUpdated: 2_000 }],
        zcodeFixtureMessages(sessionId, 3));
      createZcodeFixtureDb(dbB, [], []);

      const managerA = makeManager({ trackerDir: trackerA, baseUrl, machineId: "deviceA", home: homeA });
      const managerB = makeManager({ trackerDir: trackerB, baseUrl, machineId: "deviceB", home: homeB });

      await managerA.startUpload([{ agent: "zcode", sessionId }]);
      await waitForJob(managerA);
      await managerB.refreshRemote();
      await managerB.startImport([{ device: "deviceA", agent: "zcode", sessionId }]);
      const job = await waitForJob(managerB);
      assert.equal(job.items[0].status, "done");

      const ids = await store.readImportedMessageIds(trackerB);
      assert.equal(ids.length, 3, "all imported message ids registered for usage skipping");
      const { loadSessionSyncExcludedMessageIds } = require("../src/commands/sync");
      const excluded = loadSessionSyncExcludedMessageIds(trackerB);
      assert.equal(excluded.size, 3);
      assert.ok(excluded.has(zcodeFixtureMessages(sessionId, 1)[0].id));
    } finally {
      await server.close();
    }
  });
});

test("session-sync manager: busy lock refuses a second concurrent job", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const tracker = path.join(dir, "tracker");
    // A stale job.lock from a crashed process must not wedge the manager
    // forever: openLock reclaims dead locks (pid heartbeat).
    const content = codexRolloutContent();
    const absPath = await writeCodexFixture(home, content);
    await writeLegacyCursor(tracker, absPath, freshCursorFor(content));
    const server = createBinaryWebDavServer();
    const baseUrl = await server.listen();
    try {
      const manager = makeManager({ trackerDir: tracker, baseUrl, machineId: "deviceX", home });
      const first = await manager.startUpload([{ agent: "codex", sessionId: CODEX_SESSION_ID }]);
      assert.ok(first.ok);
      const second = await manager.startUpload([{ agent: "codex", sessionId: CODEX_SESSION_ID }]);
      assert.equal(second.code, "BUSY");
      await waitForJob(manager);
      const third = await manager.startUpload([{ agent: "codex", sessionId: CODEX_SESSION_ID }]);
      assert.ok(third.ok);
      await waitForJob(manager);
    } finally {
      await server.close();
    }
  });
});

test("session-sync manager: gzip payload bytes counted in traffic ledger", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const tracker = path.join(dir, "tracker");
    const content = codexRolloutContent();
    const absPath = await writeCodexFixture(home, content);
    await writeLegacyCursor(tracker, absPath, freshCursorFor(content));
    const server = createBinaryWebDavServer();
    const baseUrl = await server.listen();
    try {
      const manager = makeManager({ trackerDir: tracker, baseUrl, machineId: "deviceT", home });
      await manager.startUpload([{ agent: "codex", sessionId: CODEX_SESSION_ID }]);
      await waitForJob(manager);
      const traffic = require("../src/lib/webdav/traffic");
      const spent = await traffic.read(tracker);
      assert.ok(spent.uploaded >= gzipBuffer(Buffer.from(content, "utf8")).byteLength,
        "upload traffic recorded through the shared client and flushed to the monthly ledger");
    } finally {
      await server.close();
    }
  });
});

test("session-sync usage log: jobs, items, refresh and delete leave analyzable event trails", async () => {
  await withTempDir(async (dir) => {
    const usageLog = require("../src/lib/session-sync/log");
    const home = path.join(dir, "home");
    const tracker = path.join(dir, "tracker");
    const content = codexRolloutContent();
    const absPath = await writeCodexFixture(home, content, {
      indexEntries: [{ id: CODEX_SESSION_ID, thread_name: "日志对话", updated_at: "2026-11-14T02:14:44.000Z" }],
    });
    await writeLegacyCursor(tracker, absPath, freshCursorFor(content));
    const server = createBinaryWebDavServer();
    const baseUrl = await server.listen();
    try {
      const manager = makeManager({ trackerDir: tracker, baseUrl, machineId: "deviceL", home });
      await manager.startUpload([{ agent: "codex", sessionId: CODEX_SESSION_ID }]);
      const uploadJob = await waitForJob(manager);
      await manager.refreshRemote();
      await manager.deleteRemote("codex", CODEX_SESSION_ID);
      const events = await usageLog.readEvents(tracker);
      const types = events.map((event) => event.type);
      assert.ok(types.includes("job_start"), "job_start logged");
      assert.ok(types.includes("job_end"), "job_end logged");
      assert.ok(types.includes("refresh"), "refresh logged");
      assert.ok(types.includes("delete"), "delete logged");
      const itemResult = events.find((event) => event.type === "item_result");
      assert.equal(itemResult.agent, "codex");
      assert.equal(itemResult.sessionId, CODEX_SESSION_ID);
      assert.equal(itemResult.title, "日志对话");
      assert.equal(itemResult.status, "done");
      assert.equal(itemResult.revision, 1);
      assert.ok(itemResult.bytes > 0);
      const jobEnd = events.find((event) => event.type === "job_end");
      assert.equal(jobEnd.status, "done");
      assert.equal(jobEnd.doneCount, 1);
      assert.ok(jobEnd.durationMs >= 0);
      const refresh = events.find((event) => event.type === "refresh");
      assert.equal(refresh.deviceCount, 0, "own device excluded from refresh log");
      // Unknown fields never reach the file: content, URLs, credentials.
      const raw = await fs.readFile(usageLog.logPathFor(tracker), "utf8");
      assert.ok(!raw.includes("http://"), "no URLs in usage log");
    } finally {
      await server.close();
    }
  });
});

test("session-sync usage log: sanitizes payloads and rotates past the size cap", async () => {
  await withTempDir(async (dir) => {
    const usageLog = require("../src/lib/session-sync/log");
    const tracker = path.join(dir, "tracker");
    const sanitized = usageLog.sanitizeEvent({
      jobId: "j1",
      title: "  ".padEnd(400, "长标题"),
      content: "SHOULD NOT APPEAR",
      url: "https://example.com/secret",
      bytes: 123,
      nested: { deep: true },
      sessionId: "s1",
    });
    assert.equal(sanitized.title.length, 120);
    assert.equal(sanitized.bytes, 123);
    assert.ok(!("content" in sanitized));
    assert.ok(!("url" in sanitized));
    assert.ok(!("nested" in sanitized));

    // Rotation: write events until the cap trips; the old generation moves to
    // .1 and readEvents still returns the merged history.
    for (let i = 0; i < 6000; i += 1) {
      await usageLog.appendEvent(tracker, "refresh", { deviceCount: i, sessionCount: i * 2, title: "t".repeat(120) });
    }
    assert.ok(fssync.existsSync(usageLog.logPathFor(tracker)));
    const rotated = usageLog.rotatedPathFor(tracker);
    assert.ok(fssync.existsSync(rotated), "log rotated to .1 after the size cap");
    const events = await usageLog.readEvents(tracker);
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.type === "refresh" && Number.isFinite(event.deviceCount)));
  });
});
