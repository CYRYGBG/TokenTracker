// Credential-store tests use the plain-file fallback (platform injected) so
// they never touch the real macOS Keychain or Windows DPAPI. The keychain and
// DPAPI branches are exercised only by manual verification on a real device.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  SERVICE,
  storeKind,
  saveWebdavPassword,
  loadWebdavPassword,
  clearWebdavPassword,
} = require("../src/lib/webdav/credential-store");

const FILE_PLATFORM = "linux"; // exercises the 0600-file fallback

async function withTempTracker(run) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-webdav-cred-"));
  try {
    await run(path.join(tmp, "tracker"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test("storeKind maps platforms to the right backend", () => {
  assert.equal(storeKind("darwin"), "keychain");
  assert.equal(storeKind("win32"), "dpapi");
  assert.equal(storeKind("linux"), "file");
});

test("file fallback round-trips a password with 0600 permissions and clears it", {
  // POSIX permission bits do not exist on NTFS: Node ignores mode 0o600 and
  // stat.mode never carries group/world bits to assert on. Windows stores
  // credentials through DPAPI, not this file fallback, so skip rather than
  // weaken the POSIX assertion.
  skip: process.platform === "win32",
}, async () => {
  await withTempTracker(async (trackerDir) => {
    await saveWebdavPassword({ username: "me@example.com", password: "app-secret-1", trackerDir, platform: FILE_PLATFORM });
    const stored = await loadWebdavPassword({ username: "me@example.com", trackerDir, platform: FILE_PLATFORM });
    assert.equal(stored, "app-secret-1");
    const stat = await fs.stat(path.join(trackerDir, "webdav", "credential.bin"));
    assert.equal(stat.mode & 0o077, 0, "credential file must not be group/world readable");
    await clearWebdavPassword({ username: "me@example.com", trackerDir, platform: FILE_PLATFORM });
    assert.equal(await loadWebdavPassword({ username: "me@example.com", trackerDir, platform: FILE_PLATFORM }), null);
  });
});

test("loading before saving returns null instead of throwing", async () => {
  await withTempTracker(async (trackerDir) => {
    assert.equal(await loadWebdavPassword({ username: "nobody", trackerDir, platform: FILE_PLATFORM }), null);
  });
});

test("saving requires both username and password", async () => {
  await withTempTracker(async (trackerDir) => {
    await assert.rejects(
      () => saveWebdavPassword({ username: "", password: "x", trackerDir, platform: FILE_PLATFORM }),
      /required/,
    );
  });
});

test("SERVICE name is fork-scoped", () => {
  assert.equal(SERVICE, "tokentracker-fork-webdav");
});
