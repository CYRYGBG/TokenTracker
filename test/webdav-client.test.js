// In-memory WebDAV test server for the fork sync client. Implements just the
// standard methods the client uses, with injectable faults (auth failure,
// rate limit, half-file GET, MOVE-unavailable) so the client's fallback paths
// are exercised without any real network.

const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");

const { WebDavClient, joinUrlPath, parseRetryAfterMs } = require("../src/lib/webdav/client");

function createWebDavTestServer() {
  const state = {
    collections: new Set(["/"]),
    files: new Map(), // path -> string content
    requests: [],
    faults: {}, // method -> { status, retryAfter?, corruptGet?, dropMove? }
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = decodeURIComponent(url.pathname);
    state.requests.push({ method: req.method, path: p });
    const fault = state.faults[req.method];
    if (fault && fault.status) {
      if (fault.retryAfter) res.setHeader("Retry-After", fault.retryAfter);
      res.writeHead(fault.status);
      res.end();
      return;
    }

    const auth = req.headers.authorization || "";
    if (auth !== `Basic ${Buffer.from("user:app-password").toString("base64")}`) {
      res.writeHead(401);
      res.end();
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        DAV: "1, 2",
        Allow: "OPTIONS, GET, PUT, PROPFIND, MKCOL, MOVE, DELETE",
      });
      res.end();
      return;
    }

    if (req.method === "PROPFIND") {
      if (!state.collections.has(p) && !state.files.has(p)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const depth = req.headers.depth === "0";
      const directChildren = new Set();
      for (const entry of [...state.collections, ...state.files.keys()]) {
        if (entry === p || !entry.startsWith(p === "/" ? "/" : `${p}/`)) continue;
        const rest = entry.slice(p === "/" ? 1 : p.length + 1);
        const first = rest.split("/")[0];
        if (first) directChildren.add(`${p === "/" ? "" : p}/${first}`);
      }
      const items = depth ? [] : [...directChildren];
      const rows = [p, ...items].map((href) => {
        const isCollection = state.collections.has(href);
        const file = state.files.get(href);
        const encoded = href.split("/").map(encodeURIComponent).join("/");
        return (
          `<D:response>` +
          `<D:href>${encoded}${isCollection ? "/" : ""}</D:href>` +
          `<D:propstat><D:prop>` +
          (isCollection ? `<D:resourcetype><D:collection/></D:resourcetype>` : `<D:resourcetype/>`) +
          (file != null ? `<D:getcontentlength>${Buffer.byteLength(file)}</D:getcontentlength>` : "") +
          `<D:getlastmodified>Mon, 26 Oct 2026 00:00:00 GMT</D:getlastmodified>` +
          `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
          `</D:response>`
        );
      });
      res.writeHead(207, { "Content-Type": "application/xml" });
      res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${rows.join("")}</D:multistatus>`);
      return;
    }

    if (req.method === "MKCOL") {
      if (state.collections.has(p) || state.files.has(p)) {
        res.writeHead(405);
        res.end();
        return;
      }
      state.collections.add(p);
      res.writeHead(201);
      res.end();
      return;
    }

    if (req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        state.files.set(p, body);
        res.writeHead(201);
        res.end();
      });
      return;
    }

    if (req.method === "GET") {
      const file = state.files.get(p);
      if (file == null) {
        res.writeHead(404);
        res.end();
        return;
      }
      const payload = fault && fault.corruptGet ? file.slice(0, Math.floor(file.length / 2)) : file;
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(payload);
      return;
    }

    if (req.method === "MOVE") {
      if (fault && fault.dropMove) {
        // Server that does not implement MOVE for this resource.
        res.writeHead(405);
        res.end();
        return;
      }
      const destinationHeader = req.headers.destination || "";
      const destination = decodeURIComponent(new URL(destinationHeader).pathname);
      if (!state.files.has(p) && !state.collections.has(p)) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (state.files.has(destination)) {
        res.writeHead(412);
        res.end();
        return;
      }
      if (state.files.has(p)) state.files.set(destination, state.files.get(p));
      else state.collections.add(destination);
      state.files.delete(p);
      state.collections.delete(p);
      res.writeHead(201);
      res.end();
      return;
    }

    if (req.method === "DELETE") {
      state.files.delete(p);
      state.collections.delete(p);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });

  return {
    server,
    state,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
    baseUrl: () => `http://127.0.0.1:${server.address().port}`,
  };
}

async function withServer(run) {
  const harness = createWebDavTestServer();
  await harness.listen();
  try {
    await run(harness, new WebDavClient({
      baseUrl: harness.baseUrl(),
      username: "user",
      password: "app-password",
    }));
  } finally {
    await harness.close();
  }
}

test("webdav client rejects non-http base urls and missing credentials", () => {
  assert.throws(() => new WebDavClient({ baseUrl: "ftp://x", username: "u", password: "p" }), /http/);
  assert.throws(() => new WebDavClient({ baseUrl: "https://x", username: "", password: "p" }));
  assert.throws(() => new WebDavClient({ baseUrl: "https://x", username: "u" }));
});

test("webdav client authenticates and probes capabilities", async () => {
  await withServer(async (harness, client) => {
    const caps = await client.probeCapabilities("/");
    assert.equal(caps.davClass.includes("1"), true);
    assert.equal(caps.supportsMove, true);
    assert.equal(caps.supportsDelete, true);
    // Wrong credentials are surfaced as WEBDAV_UNAUTHORIZED.
    const bad = new WebDavClient({ baseUrl: harness.baseUrl(), username: "user", password: "nope" });
    await assert.rejects(() => bad.probeCapabilities("/"), (error) => error.code === "WEBDAV_UNAUTHORIZED");
  });
});

test("ensureCollection builds nested paths and tolerates existing collections", async () => {
  await withServer(async (_harness, client) => {
    assert.deepEqual(await client.ensureCollection("/tokentracker-fork/devices/machine-a"), { ok: true });
    assert.deepEqual(await client.ensureCollection("/tokentracker-fork/devices/machine-a"), { ok: true });
    const listing = await client.list("/tokentracker-fork/devices");
    assert.equal(listing.ok, true);
    assert.equal(listing.entries.some((entry) => entry.isCollection && entry.name === "machine-a"), true);
  });
});

test("list returns notFound for missing collections and parses entries", async () => {
  await withServer(async (_harness, client) => {
    const missing = await client.list("/definitely-missing");
    assert.equal(missing.ok, true);
    assert.equal(missing.notFound, true);
    await client.ensureCollection("/d");
    await client.put("/d/file-one.jsonl", "hello");
    const listing = await client.list("/d");
    const file = listing.entries.find((entry) => entry.name === "file-one.jsonl");
    assert.equal(file.isCollection, false);
    assert.equal(file.contentLength, 5);
  });
});

test("putAtomic publishes via MOVE and leaves no part file", async () => {
  await withServer(async (_harness, client) => {
    const result = await client.putAtomic("/d/x.jsonl", "payload-body");
    assert.equal(result.ok, true);
    assert.equal(result.atomic, true);
    const got = await client.get("/d/x.jsonl");
    assert.equal(got.body, "payload-body");
    const part = await client.get("/d/x.jsonl.part");
    assert.equal(part.notFound, true);
  });
});

test("putAtomic falls back to direct PUT when MOVE is unavailable", async () => {
  await withServer(async (_harness, client) => {
    _harness.state.faults.MOVE = { dropMove: true };
    const result = await client.putAtomic("/d/y.jsonl", "fallback-body");
    assert.equal(result.ok, true);
    assert.equal(result.atomic, false);
    const got = await client.get("/d/y.jsonl");
    assert.equal(got.body, "fallback-body");
    const part = await client.get("/d/y.jsonl.part");
    assert.equal(part.notFound, true, "part file cleaned up after fallback");
  });
});

test("rate limit responses surface retryAfterMs for backoff", async () => {
  await withServer(async (harness, client) => {
    harness.state.faults.PUT = { status: 429, retryAfter: "30" };
    const result = await client.put("/d/z.jsonl", "x");
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.retryAfterMs, 30_000);
    harness.state.faults.PUT = null;
  });
});

test("auth failures surface status 401 for pause handling", async () => {
  await withServer(async (harness, _client) => {
    const unauth = new WebDavClient({ baseUrl: harness.baseUrl(), username: "u2", password: "bad" });
    const result = await unauth.put("/d/z.jsonl", "x");
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });
});

test("network failures wrap as WEBDAV_NETWORK and timeouts as WEBDAV_TIMEOUT", async () => {
  const dead = new WebDavClient({
    baseUrl: "http://127.0.0.1:1",
    username: "u",
    password: "p",
    timeoutMs: 1000,
  });
  await assert.rejects(() => dead.request("/x", { method: "GET" }), (error) => error.code === "WEBDAV_NETWORK");
  const slow = new WebDavClient({
    baseUrl: "https://10.255.255.1",
    username: "u",
    password: "p",
    timeoutMs: 1000,
    fetchImpl: () => new Promise((_resolve, reject) => {
      const timer = new (require("node:events").EventEmitter)();
      timer.name = "x";
      const err = new Error("aborted");
      err.name = "TimeoutError";
      setTimeout(() => reject(err), 10);
    }),
  });
  await assert.rejects(() => slow.request("/x", { method: "GET" }), (error) => error.code === "WEBDAV_TIMEOUT" && error.timeout_ms === 1000 && error.operation === 'GET');
});

test("joinUrlPath composes clean paths and parseRetryAfterMs handles formats", () => {
  assert.equal(joinUrlPath("/a/", "b", undefined, "/c/"), "/a/b/c");
  assert.equal(joinUrlPath(), "/");
  assert.equal(parseRetryAfterMs("120"), 120_000);
  const future = new Date(Date.now() + 60_000).toUTCString();
  assert.ok(parseRetryAfterMs(future) > 50_000);
  assert.equal(parseRetryAfterMs("garbage"), null);
  assert.equal(parseRetryAfterMs(null), null);
});
