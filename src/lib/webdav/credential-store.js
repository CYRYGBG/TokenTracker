// Stores the WebDAV app password in the platform credential store so it never
// lands in config.json, logs, or any file that syncs (docs/fork
// /SYNC_DESIGN.md §6). macOS: Keychain via `security`. Windows: DPAPI
// (CurrentUser) with the resulting ciphertext kept in a 0600 file under the
// tracker dir (decodable only by the same Windows account). Other platforms
// fall back to a 0600 file — not first-release targets, but the code path
// stays functional for development.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const SERVICE = "tokentracker-fork-webdav";

function execFilePromise(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ""), stderr: String(stderr || ""), error });
    });
  });
}

function secretFilePath(trackerDir) {
  return path.join(trackerDir, "webdav", "credential.bin");
}

async function ensureDirFor(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

// --- macOS Keychain -----------------------------------------------------------

async function keychainSet(username, password) {
  const result = await execFilePromise("security", [
    "add-generic-password",
    "-s", SERVICE,
    "-a", username,
    "-w", password,
    "-U",
  ]);
  if (!result.ok) {
    const error = new Error("System credential store rejected the write");
    error.code = "CREDENTIAL_STORE_FAILED";
    throw error;
  }
}

async function keychainGet(username) {
  const result = await execFilePromise("security", [
    "find-generic-password",
    "-s", SERVICE,
    "-a", username,
    "-w",
  ]);
  if (!result.ok) return null;
  const value = result.stdout.trim();
  return value ? value : null;
}

// Existence probe that never prints the secret: `security find-generic-password`
// without `-w` lists attributes and exits 0 when the item exists. A definitive
// not-found (exit 44) reports false; any other failure (locked keychain, spawn
// trouble) is UNKNOWN and propagates so callers retry instead of caching a
// wrong answer.
async function keychainExists(username, { commandRunner } = {}) {
  const run = commandRunner || execFilePromise;
  const result = await run("security", [
    "find-generic-password",
    "-s", SERVICE,
    "-a", username,
  ]);
  if (result.ok) return true;
  if (result.error && result.error.code === 44) return false;
  if (/could not be found/i.test(result.stderr || "")) return false;
  const error = new Error("System credential store existence check failed");
  error.code = "CREDENTIAL_STORE_FAILED";
  throw error;
}

async function keychainClear(username) {
  await execFilePromise("security", [
    "delete-generic-password",
    "-s", SERVICE,
    "-a", username,
  ]);
}

// --- Windows DPAPI --------------------------------------------------------------

function psEscape(value) {
  return String(value).replace(/'/g, "''");
}

async function dpapiSet(username, password, trackerDir) {
  const protect = await execFilePromise("powershell", [
    "-NoProfile",
    "-Command",
    "Add-Type -AssemblyName System.Security; " +
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect(` +
    `[Text.Encoding]::UTF8.GetBytes('${psEscape(password)}'), $null, ` +
    "[Security.Cryptography.DataProtectionScope]::CurrentUser))",
  ]);
  if (!protect.ok || !protect.stdout.trim()) {
    const error = new Error("System credential store rejected the write");
    error.code = "CREDENTIAL_STORE_FAILED";
    throw error;
  }
  const filePath = secretFilePath(trackerDir);
  await ensureDirFor(filePath);
  await fsp.writeFile(filePath, protect.stdout.trim(), { encoding: "utf8", mode: 0o600 });
  await fsp.writeFile(`${filePath}.meta`, `${username}\n`, { encoding: "utf8", mode: 0o600 });
}

async function dpapiGet(trackerDir) {
  const filePath = secretFilePath(trackerDir);
  let ciphertext;
  try {
    ciphertext = (await fsp.readFile(filePath, "utf8")).trim();
  } catch {
    return null;
  }
  if (!ciphertext) return null;
  const unprotect = await execFilePromise("powershell", [
    "-NoProfile",
    "-Command",
    "Add-Type -AssemblyName System.Security; " +
    "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect(" +
    `[Convert]::FromBase64String('${psEscape(ciphertext)}'), $null, ` +
    "[Security.Cryptography.DataProtectionScope]::CurrentUser))",
  ]);
  if (!unprotect.ok) return null;
  const value = unprotect.stdout.replace(/\r?\n$/, "");
  return value ? value : null;
}

async function dpapiClear(trackerDir) {
  const filePath = secretFilePath(trackerDir);
  await fsp.unlink(filePath).catch(() => {});
  await fsp.unlink(`${filePath}.meta`).catch(() => {});
}

// --- Plain-file fallback (linux/development) ------------------------------------

async function fileSet(password, trackerDir) {
  const filePath = secretFilePath(trackerDir);
  await ensureDirFor(filePath);
  await fsp.writeFile(filePath, password, { encoding: "utf8", mode: 0o600 });
}

async function fileGet(trackerDir) {
  try {
    const value = (await fsp.readFile(secretFilePath(trackerDir), "utf8")).trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

async function fileClear(trackerDir) {
  await fsp.unlink(secretFilePath(trackerDir)).catch(() => {});
}

// --- Public API ------------------------------------------------------------------

function storeKind(platform = process.platform) {
  if (platform === "darwin") return "keychain";
  if (platform === "win32") return "dpapi";
  return "file";
}

async function saveWebdavPassword({ username, password, trackerDir, platform, url }) {
  if (!username || !password) throw new Error("username and password are required");
  if (url) username = require("node:crypto").createHash("sha256").update(`${url}\0${username}`).digest("hex");
  const kind = storeKind(platform);
  const outcome = kind === "keychain" ? await keychainSet(username, password)
    : kind === "dpapi" ? await dpapiSet(username, password, trackerDir)
    : await fileSet(password, trackerDir);
  invalidateCredentialExistence({ username, trackerDir, platform, url });
  return outcome;
}

async function loadWebdavPassword({ username, trackerDir, platform, url }) {
  if (url) username = require("node:crypto").createHash("sha256").update(`${url}\0${username}`).digest("hex");
  const kind = storeKind(platform);
  if (kind === "keychain") return keychainGet(username);
  if (kind === "dpapi") {
    try { if ((await fsp.readFile(`${secretFilePath(trackerDir)}.meta`,"utf8")).trim() !== username) return null; } catch { return null; }
    return dpapiGet(trackerDir);
  }
  return fileGet(trackerDir);
}

async function clearWebdavPassword({ username, trackerDir, platform, url }) {
  if (url) username = require("node:crypto").createHash("sha256").update(`${url}\0${username}`).digest("hex");
  const kind = storeKind(platform);
  const outcome = kind === "keychain" ? await keychainClear(username)
    : kind === "dpapi" ? await dpapiClear(trackerDir)
    : await fileClear(trackerDir);
  invalidateCredentialExistence({ username, trackerDir, platform, url });
  return outcome;
}

// --- Credential existence (status polling) ---------------------------------------
// The dashboard polls /api/webdav/status every 15 seconds while visible; the
// status only needs to know WHETHER a credential is stored, not its value.
// Existence checks avoid decrypting anything (macOS lists keychain attributes,
// Windows and the file fallback stat files without PowerShell) and a small
// bounded cache keeps steady-state polling from spawning `security` on every
// request. save/clear invalidate immediately; a changed URL or username simply
// computes a different key. Transient store errors are never cached, so a
// locked keychain cannot permanently freeze the indicator.

const EXISTENCE_CACHE_TTL_MS = 30_000;
const existenceCache = new Map();

function existenceCacheKey({ username, trackerDir, platform, url }) {
  if (url) username = require("node:crypto").createHash("sha256").update(`${url}\0${username}`).digest("hex");
  return `${storeKind(platform)}\0${trackerDir}\0${username}`;
}

async function dpapiCredentialExists(trackerDir, username) {
  try {
    if ((await fsp.readFile(`${secretFilePath(trackerDir)}.meta`, "utf8")).trim() !== username) return false;
  } catch {
    return false;
  }
  try {
    const stat = await fsp.stat(secretFilePath(trackerDir));
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function fileCredentialExists(trackerDir) {
  try {
    const stat = await fsp.stat(secretFilePath(trackerDir));
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function webdavCredentialExists({ username, trackerDir, platform = process.platform, url, cacheTtlMs = EXISTENCE_CACHE_TTL_MS, commandRunner } = {}) {
  if (!username || typeof username !== "string") return false;
  const key = existenceCacheKey({ username, trackerDir, platform, url });
  const cached = existenceCache.get(key);
  if (cached && Date.now() - cached.at < (Number(cacheTtlMs) || 0)) return cached.present;
  const hashedUsername = url
    ? require("node:crypto").createHash("sha256").update(`${url}\0${username}`).digest("hex")
    : username;
  const kind = storeKind(platform);
  let present;
  if (kind === "keychain") present = await keychainExists(hashedUsername, { commandRunner });
  else if (kind === "dpapi") present = await dpapiCredentialExists(trackerDir, hashedUsername);
  else present = await fileCredentialExists(trackerDir);
  // cacheTtlMs=0 means "do not cache at all" — probes never poison later reads.
  if ((Number(cacheTtlMs) || 0) > 0) existenceCache.set(key, { present, at: Date.now() });
  return present;
}
function invalidateCredentialExistence({ username, trackerDir, platform = process.platform, url } = {}) {
  existenceCache.delete(existenceCacheKey({ username, trackerDir, platform, url }));
}

module.exports = {
  SERVICE,
  storeKind,
  saveWebdavPassword,
  loadWebdavPassword,
  clearWebdavPassword,
  webdavCredentialExists,
  invalidateCredentialExistence,
  EXISTENCE_CACHE_TTL_MS,
};
