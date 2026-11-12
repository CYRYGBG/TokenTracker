// Monthly WebDAV traffic accounting: the client feeds an in-memory
// accumulator, the scheduler flushes it to webdav/traffic.json per cycle, and
// the sync page reads it via /api/webdav/status. 坚果云 meters monthly
// upload/download separately, so the counters are per calendar month.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const traffic = require("../src/lib/webdav/traffic");
const { WebDavClient } = require("../src/lib/webdav/client");

test("traffic: records, flushes and reads cumulative bytes per month", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-webdav-traffic-"));
  try {
    const before = await traffic.read(dir);
    assert.match(before.month, /^\d{4}-\d{2}$/);
    assert.equal(before.uploaded, 0);
    assert.equal(before.downloaded, 0);
    assert.equal(before.updatedAt, null);

    traffic.record({ uploaded: 100, downloaded: 40 });
    traffic.record({ uploaded: 23 });
    const flushed = await traffic.flush(dir);
    assert.equal(flushed.uploaded, 123);
    assert.equal(flushed.downloaded, 40);
    assert.ok(flushed.updatedAt);

    const after = await traffic.read(dir);
    assert.equal(after.uploaded, 123);
    assert.equal(after.downloaded, 40);
    assert.equal(after.month, before.month);

    // The next flush accumulates on top of the persisted counters.
    traffic.record({ uploaded: 1, downloaded: 2 });
    await traffic.flush(dir);
    const again = await traffic.read(dir);
    assert.equal(again.uploaded, 124);
    assert.equal(again.downloaded, 42);

    // A stale-month file resets the counters instead of carrying them over.
    const file = path.join(dir, "webdav", "traffic.json");
    const stale = JSON.parse(await fs.readFile(file, "utf8"));
    stale.month = "2000-01";
    stale.uploaded = 9999999;
    await fs.writeFile(file, JSON.stringify(stale));
    const reset = await traffic.read(dir);
    assert.equal(reset.uploaded, 0);
    assert.equal(reset.downloaded, 0);
    assert.notEqual(reset.month, "2000-01");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("traffic: client counts uploads per attempt and downloads per body", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-webdav-traffic-client-"));
  try {
    const client = new WebDavClient({
      baseUrl: "https://webdav.example",
      username: "u",
      password: "p",
      fetchImpl: async (url, init) => new Response(
        init.method === "GET" ? "hello world" : "",
        { status: init.method === "PUT" ? 201 : 200 },
      ),
    });
    await client.put("/a/b", "x".repeat(50));
    await client.get("/a/b");
    let snap = traffic.snapshot();
    assert.equal(snap.uploaded, 50);
    assert.equal(snap.downloaded, Buffer.byteLength("hello world"));

    // A failed PUT still had its body on the wire: uploads are counted per
    // attempt, matching how providers meter the payload.
    const failing = new WebDavClient({
      baseUrl: "https://webdav.example",
      username: "u",
      password: "p",
      fetchImpl: async () => new Response("", { status: 507 }),
    });
    await failing.put("/a/b", "y".repeat(10));
    snap = traffic.snapshot();
    assert.equal(snap.uploaded, 60);

    const flushed = await traffic.flush(dir);
    assert.equal(flushed.uploaded, 60);
    assert.equal(flushed.downloaded, 11);
    assert.equal(traffic.snapshot().uploaded, 0);
    assert.equal(traffic.snapshot().downloaded, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
