// Local-API security and local-sync contract tests for the personal fork.
// The cloud-era tests (auth proxy, insforgeBaseUrl overrides, relayed device
// tokens, drain uploads) were removed with the features they covered; this
// file keeps the surfaces that still exist: local auth tokens, local mutation
// authorization, and the strict-boolean local-sync spawn contract.

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

function createRequest({ method = "GET", headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;

  process.nextTick(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });

  return req;
}

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk ? Buffer.from(chunk) : Buffer.alloc(0);
    },
  };
}

async function getLocalAuthToken(handler) {
  const req = createRequest({ method: "GET" });
  const res = createResponse();
  const handled = await handler(req, res, new URL("http://127.0.0.1/api/local-auth"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  const body = JSON.parse(res.body.toString("utf8"));
  assert.equal(typeof body.token, "string");
  assert.ok(body.token.length > 0);
  return body.token;
}

function loadLocalApiWithSpawn(fakeSpawn) {
  const childProcess = require("node:child_process");
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = fakeSpawn;
  delete require.cache[require.resolve("../src/lib/local-api")];
  const mod = require("../src/lib/local-api");
  const factory = mod.createLocalApiHandler;
  const generated = [];
  mod.createLocalApiHandler = options => {
    const queuePath = path.dirname(options.queuePath) === process.cwd()
      ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-local-api-spawn-")), "queue.jsonl") : options.queuePath;
    if (queuePath !== options.queuePath) generated.push(path.dirname(queuePath));
    return factory({ ...options, queuePath, trackerDataDir: path.dirname(queuePath), syncContext: { scanSources: [] } });
  };
  return {
    mod,
    restore() {
      childProcess.spawn = originalSpawn;
      delete require.cache[require.resolve("../src/lib/local-api")];
      for (const directory of generated) fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createSuccessfulSpawn(calls) {
  return (cmd, args, options) => {
    calls.push({ cmd, args: args[0] === "-e" ? [path.join(process.cwd(), "bin/tracker.js"), "sync", ...args.slice(3)] : args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit("data", "sync ok");
      child.emit("close", 0);
    });
    return child;
  };
}

test("local device metadata exposes the system name separately from machine identity", () => {
  const { getSystemDeviceName } = require("../src/lib/local-api");
  const expected = os.hostname().replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128) || null;
  assert.equal(getSystemDeviceName(), expected);
  assert.doesNotMatch(getSystemDeviceName() || "", /^Token Tracker .*#/u);
});

test("local auth reports the serve runtime version when provided", async (t) => {
  const { createLocalApiHandler } = require("../src/lib/local-api");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-local-auth-version-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const handler = createLocalApiHandler({
    queuePath: path.join(tempDir, "queue.jsonl"),
    serverVersion: "1.2.3-test",
  });
  const req = createRequest({ method: "GET" });
  const res = createResponse();

  const handled = await handler(req, res, new URL("http://127.0.0.1/api/local-auth"));

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body.toString("utf8"));
  assert.equal(body.serverVersion, "1.2.3-test");
  assert.equal(typeof body.token, "string");
  assert.ok(body.token.length > 0);
});

test("local sync requires the local auth token", async () => {
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn([]));
  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const req = createRequest({ method: "POST", body: JSON.stringify({ auto: true }) });
    const res = createResponse();
    const handled = await handler(req, res, new URL("http://127.0.0.1/functions/tokentracker-local-sync"));
    assert.equal(handled, true);
    assert.equal(res.statusCode, 401);
  } finally {
    restore();
  }
});

test("local sync returns local_only and spawns a background sync", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));
  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({ auto: true, background: true }),
    });
    const res = createResponse();
    const handled = await handler(req, res, new URL("http://127.0.0.1/functions/tokentracker-local-sync"));
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), { ok: true, local_only: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-4), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
    ]);
  } finally {
    restore();
  }
});

test("local sync all-local background request forwards the source expansion flag", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));
  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({ auto: true, background: true, allLocalSources: true }),
    });
    const res = createResponse();
    const handled = await handler(req, res, new URL("http://127.0.0.1/functions/tokentracker-local-sync"));
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes("--all-local-sources"));
  } finally {
    restore();
  }
});

test("local sync lightweight alias forwards background mode", async () => {
  const calls = [];
  const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));
  try {
    const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
    const localAuthToken = await getLocalAuthToken(handler);
    const req = createRequest({
      method: "POST",
      headers: { "x-tokentracker-local-auth": localAuthToken },
      body: JSON.stringify({ auto: true, lightweight: true }),
    });
    const res = createResponse();
    const handled = await handler(req, res, new URL("http://127.0.0.1/functions/tokentracker-local-sync"));
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(-4), [
      path.join(process.cwd(), "bin/tracker.js"),
      "sync",
      "--auto",
      "--background",
    ]);
  } finally {
    restore();
  }
});

test("local sync only treats boolean true as background or lightweight", async () => {
  const cases = [
    { background: false },
    { background: "true" },
    { background: 1 },
    { lightweight: false },
    { lightweight: "true" },
    { lightweight: 1 },
  ];

  for (const body of cases) {
    const calls = [];
    const { mod, restore } = loadLocalApiWithSpawn(createSuccessfulSpawn(calls));
    try {
      const handler = mod.createLocalApiHandler({ queuePath: path.join(process.cwd(), "tmp-queue.jsonl") });
      const localAuthToken = await getLocalAuthToken(handler);
      const req = createRequest({
        method: "POST",
        headers: { "x-tokentracker-local-auth": localAuthToken },
        body: JSON.stringify({ auto: true, ...body }),
      });
      const res = createResponse();
      const handled = await handler(req, res, new URL("http://127.0.0.1/functions/tokentracker-local-sync"));
      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].args.includes("--background"), false,
        `background must stay opt-in for ${JSON.stringify(body)}`);
    } finally {
      restore();
    }
  }
});
