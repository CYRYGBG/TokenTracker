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
  webdavCredentialExists,
} = require("../src/lib/webdav/credential-store");
const fsp = require("node:fs/promises");

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

test("credential existence never decrypts and caches within its TTL", async () => {
  await withTempTracker(async (trackerDir) => {
    // File fallback: pure fs — presence tracks the stored secret exactly.
    assert.equal(await webdavCredentialExists({ username: "u", trackerDir, platform: FILE_PLATFORM, cacheTtlMs: 0 }), false);
    await saveWebdavPassword({ username: "u", password: "secret", trackerDir, platform: FILE_PLATFORM });
    assert.equal(await webdavCredentialExists({ username: "u", trackerDir, platform: FILE_PLATFORM, cacheTtlMs: 0 }), true);
    // A long TTL caches the positive answer even if the file vanishes right
    // after the check (bounded staleness for a status indicator only; the
    // sync path always loads the real secret).
    assert.equal(await webdavCredentialExists({ username: "u", trackerDir, platform: FILE_PLATFORM, cacheTtlMs: 60_000 }), true);
    await clearWebdavPassword({ username: "u", trackerDir, platform: FILE_PLATFORM });
    // save/clear invalidate immediately — the cleared state shows at once.
    assert.equal(await webdavCredentialExists({ username: "u", trackerDir, platform: FILE_PLATFORM, cacheTtlMs: 60_000 }), false);
    // The file fallback is a single-slot store (loadWebdavPassword ignores
    // the username on this platform), so presence is per-tracker, not
    // per-account. Re-saving keeps it present; the cache never outlives it.
    await saveWebdavPassword({ username: "u", password: "secret", trackerDir, platform: FILE_PLATFORM });
    assert.equal(await webdavCredentialExists({ username: "u", trackerDir, platform: FILE_PLATFORM, cacheTtlMs: 60_000 }), true);
    await fsp.unlink(path.join(trackerDir, "webdav", "credential.bin"));
    assert.equal(await webdavCredentialExists({ username: "u", trackerDir, platform: FILE_PLATFORM, cacheTtlMs: 0 }), false);
  });
});

test("keychain existence probes attributes without printing the secret and treats unknown errors as retryable", async () => {
  await withTempTracker(async () => {
    const calls = [];
    const fakeRunner = async (file, args) => {
      calls.push({ file, args });
      return { ok: false, stdout: "", stderr: "SecKeychainSearch...The specified item could not be found in the keychain.", error: Object.assign(new Error("not found"), { code: 44 }) };
    };
    assert.equal(await webdavCredentialExists({ username: "u", trackerDir: "/tmp/x", platform: "darwin", cacheTtlMs: 0, commandRunner: fakeRunner }), false);
    // No `-w` flag: the probe never asks for the secret value.
    assert.ok(calls.every((c) => !c.args.includes("-w")));
    // A locked keychain is neither present nor absent: the error surfaces
    // (so the poll retries later) and nothing is cached.
    const locked = async () => ({ ok: false, stdout: "", stderr: "User interaction is not allowed.", error: Object.assign(new Error("locked"), { code: -25308 }) });
    await assert.rejects(
      () => webdavCredentialExists({ username: "u", trackerDir: "/tmp/x", platform: "darwin", cacheTtlMs: 0, commandRunner: locked }),
      /existence check failed/,
    );
    const recovered = async () => ({ ok: true, stdout: "attributes", stderr: "", error: null });
    assert.equal(await webdavCredentialExists({ username: "u", trackerDir: "/tmp/x", platform: "darwin", cacheTtlMs: 60_000, commandRunner: recovered }), true);
  });
});

test("dpapi existence is a pure file check and never spawns PowerShell", async () => {
  await withTempTracker(async (trackerDir) => {
    const crypto = require("node:crypto");
    const user = crypto.createHash("sha256").update("https://dav.example.com\0u").digest("hex");
    // Nothing stored yet.
    assert.equal(await webdavCredentialExists({ username: "u", url: "https://dav.example.com", trackerDir, platform: "win32", cacheTtlMs: 0 }), false);
    const fsp = require("node:fs/promises");
    await fsp.mkdir(path.join(trackerDir, "webdav"), { recursive: true });
    await fsp.writeFile(path.join(trackerDir, "webdav", "credential.bin.meta"), `${user}\n`);
    // Meta without the ciphertext is not a credential.
    assert.equal(await webdavCredentialExists({ username: "u", url: "https://dav.example.com", trackerDir, platform: "win32", cacheTtlMs: 0 }), false);
    await fsp.writeFile(path.join(trackerDir, "webdav", "credential.bin"), "ciphertext");
    assert.equal(await webdavCredentialExists({ username: "u", url: "https://dav.example.com", trackerDir, platform: "win32", cacheTtlMs: 0 }), true);
    // A different bound account does not see the credential.
    assert.equal(await webdavCredentialExists({ username: "v", url: "https://dav.example.com", trackerDir, platform: "win32", cacheTtlMs: 0 }), false);
  });
});
