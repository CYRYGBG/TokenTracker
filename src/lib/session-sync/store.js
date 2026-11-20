"use strict";

// Local registry + job state for the manual conversation sync. Small JSON
// documents persisted through fork-store's transactional update (same pattern
// as fork-prefs.append) so concurrent serve/API writes cannot interleave.

const fs = require("node:fs/promises");
const path = require("node:path");
const durable = require("../fork-store");
const {
  registryPathFor,
  jobPathFor,
  importedMessageIdsPathFor,
  backupsDirFor,
  writeJsonAtomic,
  nowIso,
} = require("./common");

const REGISTRY_DEFAULT = Object.freeze({
  version: 1,
  uploaded: {},
  imported: {},
  remoteCache: { fetchedAt: null, devices: {} },
});

function registryKey(agent, sessionId) {
  return `${agent}:${sessionId}`;
}

async function readRegistry(trackerDir) {
  const raw = await durable.read(registryPathFor(trackerDir), null);
  if (!raw || typeof raw !== "object" || typeof raw.uploaded !== "object" || typeof raw.imported !== "object") {
    return { ...REGISTRY_DEFAULT, uploaded: {}, imported: {}, remoteCache: { fetchedAt: null, devices: {} } };
  }
  return {
    version: 1,
    uploaded: raw.uploaded,
    imported: raw.imported,
    remoteCache: raw.remoteCache && typeof raw.remoteCache === "object"
      ? raw.remoteCache
      : { fetchedAt: null, devices: {} },
  };
}

async function updateRegistry(trackerDir, transform) {
  return durable.update(registryPathFor(trackerDir), null, (prior) => {
    const base = prior && typeof prior === "object" && typeof prior.uploaded === "object"
      ? prior
      : { version: 1, uploaded: {}, imported: {}, remoteCache: { fetchedAt: null, devices: {} } };
    return transform(base);
  });
}

async function recordUpload(trackerDir, agent, sessionId, entry) {
  await updateRegistry(trackerDir, (registry) => {
    registry.uploaded[registryKey(agent, sessionId)] = { ...entry, uploadedAt: nowIso() };
    return registry;
  });
}

async function recordImport(trackerDir, agent, sessionId, entry) {
  await updateRegistry(trackerDir, (registry) => {
    registry.imported[registryKey(agent, sessionId)] = { ...entry, importedAt: nowIso() };
    return registry;
  });
}

async function forgetRemoteCache(trackerDir) {
  await updateRegistry(trackerDir, (registry) => {
    registry.remoteCache = { fetchedAt: null, devices: {} };
    return registry;
  });
}

// ---------------------------------------------------------------------------
// Imported ZCode message ids: the usage scanner skips exactly these rows so an
// imported conversation is never re-counted on this device (SYNC_DESIGN §12.4).
// Kept in its own small file — read once per scan child via mtimeCheck.
// ---------------------------------------------------------------------------

async function appendImportedMessageIds(trackerDir, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const file = importedMessageIdsPathFor(trackerDir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const current = await readImportedMessageIds(trackerDir);
  const set = new Set(current);
  for (const id of ids) if (typeof id === "string" && id) set.add(id);
  await writeJsonAtomic(file, [...set]);
}

async function readImportedMessageIds(trackerDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(importedMessageIdsPathFor(trackerDir), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string" && id) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Job state. The in-process runner mirrors its progress here so the dashboard
// can poll /api/session-sync/status across requests and after crashes.
// ---------------------------------------------------------------------------

async function readJob(trackerDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(jobPathFor(trackerDir), "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeJob(trackerDir, job) {
  await writeJsonAtomic(jobPathFor(trackerDir), { ...job, updatedAt: nowIso() });
}

async function prepareBackupDir(trackerDir) {
  await fs.mkdir(backupsDirFor(trackerDir), { recursive: true, mode: 0o700 });
  return backupsDirFor(trackerDir);
}

module.exports = {
  registryKey,
  readRegistry,
  updateRegistry,
  recordUpload,
  recordImport,
  forgetRemoteCache,
  readImportedMessageIds,
  appendImportedMessageIds,
  readJob,
  writeJob,
  prepareBackupDir,
};
