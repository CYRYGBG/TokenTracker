const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { createWebDavTestServer } = require("./helpers/webdav-server");
const {
  serializeDocument,
  parseDocument,
} = require("../src/lib/sync-store/format");
const { createDeviceImportStore } = require("../src/lib/sync-store/importer");
async function start(home) {
  const child = fork(path.join(__dirname, "helpers/fork-api-server.cjs"), [], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TOKENTRACKER_PERSONAL: "0",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const [{ port }] = await once(child, "message");
  const base = `http://127.0.0.1:${port}`;
  const { token } = await (await fetch(base + "/api/local-auth")).json();
  return {
    async request(p, method = "GET", body) {
      const r = await fetch(base + p, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-tokentracker-local-auth": token,
          Origin: base,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const d = await r.json();
      assert.ok(r.ok, JSON.stringify(d));
      if (p.startsWith("/functions/tokentracker-usage-summary")) {
        assert.equal(
          r.headers.get("X-TokenTracker-Account-View"),
          d.device === "all" || d.device === "machine-bbbb" ? "1" : "0",
        );
        assert.equal(
          r.headers.get("X-TokenTracker-Sync-Partial"),
          d.partial ? "1" : "0",
        );
      }
      return d;
    },
    async close() {
      child.send("close");
      const [code] = await once(child, "exit");
      assert.equal(code, 0, stderr);
    },
  };
}
async function fixture(home, id, total) {
  const dir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ machineId: id }),
  );
  const row = {
    source: "claude",
    model: "claude-sonnet-4-6",
    hour_start: "2026-10-25T10:00:00.000Z",
    input_tokens: total,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: total,
    billable_total_tokens: total,
  };
  await fs.writeFile(
    path.join(dir, "queue.jsonl"),
    JSON.stringify({
      ...row,
      prompt: "DO-NOT-UPLOAD",
      api_key: "DO-NOT-UPLOAD",
    }) + "\n",
  );
  await fs.writeFile(
    path.join(dir, "project.queue.jsonl"),
    [
      {
        ...row,
        project_key: "acme/shared",
        total_tokens: total - 1,
        input_tokens: total - 1,
        billable_total_tokens: total - 1,
        project_ref: "https://github.com/acme/shared",
      },
      {
        ...row,
        project_key: "other/shared",
        project_ref: "https://github.com/other/shared",
        total_tokens: 1,
        input_tokens: 1,
        billable_total_tokens: 1,
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  const source = path.join(home, ".claude", "projects", "project");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(
    path.join(source, "session.jsonl"),
    [
      {
        type: "user",
        sessionId: id,
        cwd: "/Users/private/project",
        timestamp: "2026-10-25T10:00:00Z",
        message: { content: "DO-NOT-UPLOAD" },
      },
      {
        type: "assistant",
        sessionId: id,
        cwd: "/Users/private/project",
        timestamp: "2026-10-25T10:01:00Z",
        message: {
          id: "message",
          model: row.model,
          usage: { input_tokens: total, output_tokens: 0 },
          content: [
            {
              type: "tool_use",
              name: "Edit",
              input: { file_path: "DO-NOT-UPLOAD" },
            },
          ],
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  return { dir, source };
}
test("settings → real WebDAV → isolated peer API: details, prefs, privacy, failures and process restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-fork-e2e-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homes = [path.join(root, "a"), path.join(root, "b")];
  const aFixture = await fixture(homes[0], "machine-aaaa", 100);
  await fixture(homes[1], "machine-bbbb", 200);
  const dav = createWebDavTestServer();
  await dav.listen();
  t.after(() => dav.close());
  let a = await start(homes[0]);
  let b = await start(homes[1]);
  t.after(async () => {
    await a.close();
    await b.close();
  });
  for (const api of [a, b])
    await api.request("/api/webdav/config", "PUT", {
      url: dav.baseUrl(),
      username: "user",
      password: "app-password",
      directory: "stats",
      device_name: "Test device",
      enabled: true,
    });
  for (const api of [a, b, a, b])
    assert.equal((await api.request("/api/webdav/sync-now", "POST")).ok, true);
  for (const api of [a, b]) {
    const total = await api.request(
      "/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-10-31",
    );
    assert.equal(Number(total.totals.total_tokens), 300, JSON.stringify(total));
    const projects = await api.request(
      "/functions/tokentracker-project-usage-summary",
    );
    assert.equal(projects.entries.length, 2);
    assert.equal(
      Number(
        projects.entries.find((p) => p.project_key === "acme/shared")
          .total_tokens,
      ),
      298,
    );
    const sessions = await api.request("/functions/tokentracker-sessions");
    assert.equal(sessions.sessions.length, 2);
    assert.equal(
      sessions.sessions.reduce((n, s) => n + s.total_tokens, 0),
      300,
    );
    assert.equal(
      sessions.sessions.filter((s) => s.remote && s.resume_command === null)
        .length,
      1,
    );
  }
  await a.request("/api/fork/prefs", "POST", {
    action: "project_alias_add",
    target: "other/shared",
    payload: { alias_to: "acme/shared" },
  });
  for (const api of [a, b]) await api.request("/api/webdav/sync-now", "POST");
  const mergedProjects = await b.request(
    "/functions/tokentracker-project-usage-summary",
  );
  assert.equal(mergedProjects.entries.length, 1);
  assert.equal(Number(mergedProjects.entries[0].total_tokens), 300);
  await b.request("/api/fork/prefs", "POST", {
    action: "project_alias_remove",
    target: "other/shared",
  });
  for (const api of [b, a]) await api.request("/api/webdav/sync-now", "POST");
  assert.equal(
    (await a.request("/functions/tokentracker-project-usage-summary")).entries
      .length,
    2,
  );
  const snapshot = await a.request("/functions/tokentracker-sessions");
  const target = snapshot.sessions[0].session_hash;
  await a.request("/api/fork/prefs", "POST", { action: "hide", target });
  const expense = {
    action: "expense_set",
    target: "payment-1",
    payload: {
      kind: "subscription",
      amount: 20,
      currency: "USD",
      date: "2026-10-25",
      provider: "Codex",
    },
  };
  await a.request("/api/fork/prefs", "POST", expense);
  await a.request("/api/fork/prefs", "POST", {
    action: "custom_price_set",
    target: "claude:fixture-model",
    payload: {
      source: "claude",
      model: "fixture-model",
      input: 1,
      output: 2,
      cache_read: 0.1,
      cache_write: 1.5,
    },
  });
  for (const api of [a, b]) await api.request("/api/webdav/sync-now", "POST");
  assert.equal(
    (await b.request("/functions/tokentracker-sessions")).sessions.length,
    1,
  );
  assert.equal(
    (await b.request("/functions/tokentracker-sessions?include_hidden=1"))
      .sessions.length,
    2,
  );
  assert.equal((await b.request("/api/fork/prefs")).expenses.length, 1);
  assert.equal(
    (await b.request("/api/fork/pricing?source=claude&model=fixture-model"))
      .model.source,
    "custom",
  );
  assert.equal(
    (await b.request("/api/fork/pricing?source=codex&model=fixture-model"))
      .model.status,
    "unpriced",
  );
  await b.request("/api/fork/prefs", "POST", { action: "unhide", target });
  for (const api of [b, a]) await api.request("/api/webdav/sync-now", "POST");
  assert.equal(
    (await a.request("/functions/tokentracker-sessions")).sessions.length,
    2,
  );
  // Source deletion and a fresh process retain collected details and imports.
  await fs.rm(aFixture.source, { recursive: true });
  await a.request("/functions/tokentracker-sessions?refresh=1");
  await a.close();
  a = await start(homes[0]);
  assert.equal(
    (await a.request("/functions/tokentracker-sessions?refresh=1")).sessions
      .length,
    2,
  );
  assert.equal((await a.request("/api/fork/prefs")).expenses.length, 1);
  const backup = await a.request("/api/fork/backup");
  assert.equal(backup.format, "tokentracker-personal-backup");
  const backupText = JSON.stringify(backup);
  for (const forbidden of [
    "DO-NOT-UPLOAD",
    "app-password",
    "/Users/private",
    "resume_command",
  ])
    assert.equal(backupText.includes(forbidden), false);
  assert.equal(
    (await a.request("/api/fork/backup", "POST", backup)).added,
    0,
    "restoring current backup is a no-op",
  );
  await fs.rm(path.join(aFixture.dir, "webdav", "imports"), {
    recursive: true,
  });
  assert.ok((await a.request("/api/fork/backup", "POST", backup)).added > 0);
  assert.equal(
    (await a.request("/functions/tokentracker-sessions")).sessions.length,
    2,
  );

  await a.request("/api/fork/view", "PUT", { device: "machine-bbbb" });
  assert.equal(
    Number(
      (
        await a.request(
          "/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-10-31",
        )
      ).totals.total_tokens,
    ),
    200,
  );
  await a.request("/api/fork/view", "PUT", { device: "all" });
  dav.state.faults.PROPFIND = { status: 429, retryAfter: "120" };
  assert.equal((await a.request("/api/webdav/sync-now", "POST")).ok, false);
  const degraded = await a.request(
    "/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-10-31",
  );
  assert.equal(Number(degraded.totals.total_tokens), 300);
  assert.equal(degraded.partial, true);
  const status = await a.request("/api/webdav/status");
  assert.ok(
    status.sync.backoff_until_ms > Date.now() + 110000,
    "Retry-After is respected",
  );
  delete dav.state.faults.PROPFIND;
  assert.equal((await a.request("/api/webdav/sync-now", "POST")).ok, true);
  dav.state.faults.PROPFIND = { status: 401 };
  assert.equal((await a.request("/api/webdav/sync-now", "POST")).ok, false);
  assert.equal((await a.request("/api/webdav/status")).sync.paused_auth, true);
  delete dav.state.faults.PROPFIND;
  assert.equal((await a.request("/api/webdav/sync-now", "POST")).ok, true);
  assert.equal((await a.request("/api/webdav/status")).sync.paused_auth, false);
  const bQueue = path.join(homes[1], ".tokentracker", "tracker", "queue.jsonl");
  const priorRow = JSON.parse((await fs.readFile(bQueue, "utf8")).trim());
  await fs.appendFile(
    bQueue,
    JSON.stringify({
      ...priorRow,
      input_tokens: 210,
      total_tokens: 210,
      billable_total_tokens: 210,
    }) + "\n",
  );
  await b.request("/api/webdav/sync-now", "POST");
  dav.state.faults.GET = { corruptGet: true };
  await a.request("/api/webdav/sync-now", "POST");
  const corruptRead = await a.request(
    "/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-10-31",
  );
  assert.equal(Number(corruptRead.totals.total_tokens), 300);
  assert.equal(corruptRead.partial, true);
  delete dav.state.faults.GET;
  await a.request("/api/webdav/sync-now", "POST");
  assert.equal(
    Number(
      (
        await a.request(
          "/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-10-31",
        )
      ).totals.total_tokens,
    ),
    310,
  );
  dav.state.faults.MKCOL = { status: 503, retryAfter: "30" };
  assert.equal((await a.request("/api/webdav/sync-now", "POST")).ok, false);
  delete dav.state.faults.MKCOL;
  assert.equal((await a.request("/api/webdav/sync-now", "POST")).ok, true);
  const latestFile = [...dav.state.files.keys()]
    .filter((k) => k.includes("/machine-bbbb/buckets-") && k.endsWith(".jsonl"))
    .sort()
    .at(-1);
  const correct = dav.state.files.get(latestFile);
  const tampered = parseDocument(correct);
  tampered.rows[0].input_tokens += 1;
  tampered.rows[0].total_tokens += 1;
  dav.state.files.set(
    latestFile,
    serializeDocument({
      kind: tampered.header.kind,
      device: tampered.header.device,
      seq: tampered.header.seq,
      sinceSeq: tampered.header.since_seq,
      rows: tampered.rows,
    }),
  );
  await a.request("/api/webdav/sync-now", "POST");
  assert.equal(
    (await a.request("/api/webdav/status")).sync.imported["machine-bbbb"].ok,
    false,
    "same revision with different content is rejected over real transport",
  );
  dav.state.files.set(latestFile, correct);
  await a.request("/api/webdav/sync-now", "POST");
  // Simulate an old/empty local backup: raw sources are already gone, but
  // the device's own remote snapshots must restore the API as well as peers.
  await fs.rm(path.join(aFixture.dir, "fork-history"), { recursive: true });
  await fs.rm(path.join(aFixture.dir, "webdav", "state.json"));
  await fs.writeFile(path.join(aFixture.dir, "queue.jsonl"), "");
  for (const api of [a, a]) await api.request("/api/webdav/sync-now", "POST");
  assert.equal(
    Number(
      (
        await a.request(
          "/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-10-31",
        )
      ).totals.total_tokens,
    ),
    310,
  );
  assert.equal(
    (await a.request("/functions/tokentracker-sessions")).sessions.length,
    2,
  );
  await a.close();
  a = await start(homes[0]);
  assert.equal(
    Number(
      (
        await a.request(
          "/functions/tokentracker-usage-summary?from=2026-10-01&to=2026-10-31",
        )
      ).totals.total_tokens,
    ),
    310,
  );
  const wire = [...dav.state.files.values()].join("\n");
  for (const forbidden of [
    "DO-NOT-UPLOAD",
    "app-password",
    "/Users/private",
    "resume_command",
    "api_key",
  ])
    assert.equal(wire.includes(forbidden), false, forbidden);
  assert.equal(
    (
      await fs.readFile(
        path.join(aFixture.dir, "webdav", "config.json"),
        "utf8",
      )
    ).includes("app-password"),
    false,
  );
});
test("atomic import keeps distinct projects, rejects identity mismatch, conflict, gaps and corruption", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-fork-import-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createDeviceImportStore({
    importsDir: dir,
    machineId: "machine-aaaa",
  });
  const rows = [
    {
      project_key: "a/repo",
      source: "codex",
      hour_start: "2026-10-25T10:00:00Z",
      total_tokens: 100,
    },
    {
      project_key: "b/repo",
      source: "codex",
      hour_start: "2026-10-25T10:00:00Z",
      total_tokens: 200,
    },
  ];
  const doc = parseDocument(
    serializeDocument({
      kind: "projects",
      device: "machine-aaaa",
      seq: 1,
      rows,
    }),
  );
  await store.applyDocument(doc);
  assert.equal((await store.readMergedProjects()).length, 2);
  await assert.rejects(
    store.applyDocument(
      parseDocument(
        serializeDocument({
          kind: "projects",
          device: "machine-aaaa",
          seq: 1,
          rows: [rows[0]],
        }),
      ),
    ),
    /conflict/,
  );
  await assert.rejects(
    store.applyDocument(
      parseDocument(
        serializeDocument({
          kind: "projects",
          device: "machine-aaaa",
          seq: 3,
          sinceSeq: 2,
          rows,
        }),
      ),
    ),
    /predecessor/,
  );
  await assert.rejects(
    store.applyDocument({ ...doc, header: { ...doc.header, device: "other" } }),
    /identity/,
  );
  const broken = serializeDocument({
    kind: "projects",
    device: "machine-aaaa",
    seq: 2,
    rows,
  }).slice(0, -12);
  assert.throws(() => parseDocument(broken));
  assert.equal((await store.readMergedProjects()).length, 2);
  await store.applyDocument(
    parseDocument(
      serializeDocument({
        kind: "projects",
        device: "machine-aaaa",
        seq: 2,
        sinceSeq: 1,
        rows: [{ ...rows[0], total_tokens: 40 }],
      }),
    ),
  );
  assert.equal(
    (await store.readMergedProjects()).reduce((n, r) => n + r.total_tokens, 0),
    240,
  );
});
