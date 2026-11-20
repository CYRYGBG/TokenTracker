"use strict";

// Remote WebDAV layout for the manual conversation sync (SYNC_DESIGN §12.1).
// All functions are pure with respect to an injected WebDavClient so tests can
// drive them against the in-memory loopback server fixture.
//
//   <directory>/session-sync/
//     devices/<machineId>/device.json
//     devices/<machineId>/sessions/index.json
//     devices/<machineId>/sessions/<agent>/<sessionId>/meta.json
//     devices/<machineId>/sessions/<agent>/<sessionId>/payload/<key>.gz

const { WebDavClient } = require("../webdav/client");
const {
  gzipBuffer,
  gunzipBuffer,
  isValidPayloadKey,
  nowIso,
} = require("./common");

const ROOT = "session-sync";
const INDEX_FORMAT = 1;
const META_FORMAT = 1;
const MACHINE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function remoteBase(directory) {
  return `/${directory}/${ROOT}/devices`;
}

function devicePath(directory, machineId) {
  return `${remoteBase(directory)}/${machineId}`;
}

function sessionDirPath(directory, machineId, agent, sessionId) {
  return `${devicePath(directory, machineId)}/sessions/${agent}/${sessionId}`;
}

function indexPath(directory, machineId) {
  return `${devicePath(directory, machineId)}/sessions/index.json`;
}

function metaPath(directory, machineId, agent, sessionId) {
  return `${sessionDirPath(directory, machineId, agent, sessionId)}/meta.json`;
}

function payloadPath(directory, machineId, agent, sessionId, key) {
  return `${sessionDirPath(directory, machineId, agent, sessionId)}/payload/${key}.gz`;
}

function normalizeDirectory(directory) {
  const trimmed = typeof directory === "string" ? directory.trim().replace(/^\/+|\/+$/g, "") : "";
  return trimmed || "tokentracker-fork";
}

function createClient({ config, password, fetchImpl }) {
  if (!config?.url || !config?.username) {
    const error = new Error("webdav not configured");
    error.code = "NOT_CONFIGURED";
    throw error;
  }
  if (!password) {
    const error = new Error("webdav credential missing");
    error.code = "MISSING_CREDENTIAL";
    throw error;
  }
  return new WebDavClient({
    baseUrl: config.url,
    username: config.username,
    password,
    fetchImpl,
  });
}

// Republished files (device.json / meta.json / index.json / payload blobs on
// revision bumps) are written with a direct PUT: MOVE with Overwrite:F fails
// with 412 once the destination exists, and the statistics scheduler uses the
// same direct-PUT contract for its republished device.json. Import-side SHA
// verification is the truncation safety net.
async function publishJson(client, filePath, value) {
  const body = JSON.stringify(value, null, 2);
  const result = await client.put(filePath, body);
  if (!result.ok) {
    const error = new Error(`webdav publish failed with ${result.status}`);
    error.code = result.status === 401 || result.status === 403 ? "WEBDAV_UNAUTHORIZED" : "WEBDAV_HTTP";
    error.status = result.status;
    throw error;
  }
}

async function publishPayload(client, filePath, buffer) {
  const result = await client.put(filePath, buffer);
  if (!result.ok) {
    const error = new Error(`webdav payload publish failed with ${result.status}`);
    error.code = result.status === 401 || result.status === 403 ? "WEBDAV_UNAUTHORIZED" : "WEBDAV_HTTP";
    error.status = result.status;
    throw error;
  }
}

async function ensureDeviceCollection(client, directory, machineId, deviceInfo) {
  if (!MACHINE_ID_RE.test(machineId)) {
    const error = new Error("invalid machine id");
    error.code = "SESSION_SYNC_INVALID_DEVICE";
    throw error;
  }
  const ensured = await client.ensureCollection(`${devicePath(directory, machineId)}/sessions`);
  if (!ensured.ok) {
    const error = new Error(`webdav MKCOL failed with ${ensured.status}`);
    error.code = ensured.status === 401 || ensured.status === 403 ? "WEBDAV_UNAUTHORIZED" : "WEBDAV_HTTP";
    error.status = ensured.status;
    throw error;
  }
  await publishJson(client, `${devicePath(directory, machineId)}/device.json`, {
    format: 1,
    id: machineId,
    name: deviceInfo?.name || null,
    platform: deviceInfo?.platform || null,
    updated_at: nowIso(),
  });
}

// Upload one conversation bundle. `files` = [{key, buffer, sha256, bytes}] with
// plain-content hashes already verified by the caller. The remote meta carries
// both plain and gzip digests so the importer can validate every hop.
async function uploadBundle(client, { directory, machineId, agent, sessionId, meta, files, summaries }) {
  await ensureDeviceCollection(client, directory, machineId, meta.device);
  const dir = sessionDirPath(directory, machineId, agent, sessionId);
  const ensured = await client.ensureCollection(`${dir}/payload`);
  if (!ensured.ok) {
    const error = new Error(`webdav MKCOL failed with ${ensured.status}`);
    error.code = "WEBDAV_HTTP";
    error.status = ensured.status;
    throw error;
  }
  const fileEntries = [];
  for (const file of files) {
    if (!isValidPayloadKey(file.key)) {
      const error = new Error(`invalid payload key: ${file.key}`);
      error.code = "SESSION_SYNC_INVALID_KEY";
      throw error;
    }
    const gz = gzipBuffer(file.buffer);
    await publishPayload(client, payloadPath(directory, machineId, agent, sessionId, file.key), gz);
    fileEntries.push({
      key: file.key,
      bytes: file.bytes,
      sha256: file.sha256,
      bytes_gz: gz.byteLength,
      sha256_gz: null,
    });
  }
  const remoteMeta = {
    format: META_FORMAT,
    agent,
    session_id: sessionId,
    title: meta.title || null,
    cwd: meta.cwd || null,
    project: meta.project || null,
    revision: meta.revision,
    updated_at: nowIso(),
    origin_device: machineId,
    origin_device_name: meta.device?.name || null,
    cursor: meta.cursor || null,
    extra: meta.extra || null,
    files: fileEntries,
  };
  await publishJson(client, metaPath(directory, machineId, agent, sessionId), remoteMeta);
  // Refresh the device index last: a stale index only makes the new upload
  // invisible until the next refresh, never points at a missing bundle.
  await publishJson(client, indexPath(directory, machineId), {
    format: INDEX_FORMAT,
    updated_at: nowIso(),
    sessions: summaries,
  });
  return remoteMeta;
}

async function deleteBundle(client, { directory, machineId, agent, sessionId, summaries }) {
  const result = await client.delete(sessionDirPath(directory, machineId, agent, sessionId));
  if (!result.ok) {
    const error = new Error(`webdav delete failed with ${result.status}`);
    error.code = result.status === 401 || result.status === 403 ? "WEBDAV_UNAUTHORIZED" : "WEBDAV_HTTP";
    error.status = result.status;
    throw error;
  }
  await publishJson(client, indexPath(directory, machineId), {
    format: INDEX_FORMAT,
    updated_at: nowIso(),
    sessions: summaries,
  });
}

// Fetch other devices' indexes + device info. Own machineId is skipped: local
// conversations are listed from the local stores, never from the remote.
async function fetchRemoteIndexes(client, { directory, ownMachineId }) {
  const base = remoteBase(directory);
  const listing = await client.list(base);
  if (!listing.ok) {
    const error = new Error(`webdav PROPFIND failed with ${listing.status}`);
    error.code = listing.status === 401 || listing.status === 403 ? "WEBDAV_UNAUTHORIZED" : "WEBDAV_HTTP";
    error.status = listing.status;
    throw error;
  }
  if (listing.notFound) return { devices: {} };
  const devices = {};
  for (const entry of listing.entries) {
    if (!entry.isCollection) continue;
    const machineId = entry.name;
    if (!MACHINE_ID_RE.test(machineId) || machineId === ownMachineId) continue;
    const deviceInfo = await client.get(`${base}/${machineId}/device.json`);
    const index = await client.get(indexPath(directory, machineId));
    if (index.notFound) continue;
    if (!index.ok) {
      const error = new Error(`webdav index GET failed with ${index.status}`);
      error.code = "WEBDAV_HTTP";
      error.status = index.status;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(index.body);
    } catch {
      continue; // unreadable index: skip the device, keep the others listable
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sessions)) continue;
    let info = {};
    if (deviceInfo.ok && !deviceInfo.notFound) {
      try {
        const parsedInfo = JSON.parse(deviceInfo.body);
        if (parsedInfo && typeof parsedInfo === "object") info = parsedInfo;
      } catch { /* non-fatal */ }
    }
    devices[machineId] = {
      name: typeof info.name === "string" && info.name ? info.name : machineId,
      platform: typeof info.platform === "string" ? info.platform : null,
      sessions: parsed.sessions.filter(
        (session) => session && typeof session === "object" && typeof session.session_id === "string",
      ),
    };
  }
  return { devices };
}

async function fetchBundle(client, { directory, machineId, agent, sessionId }) {
  const metaResult = await client.get(metaPath(directory, machineId, agent, sessionId));
  if (metaResult.notFound) {
    const error = new Error("remote session meta not found");
    error.code = "SESSION_SYNC_REMOTE_MISSING";
    throw error;
  }
  if (!metaResult.ok) {
    const error = new Error(`webdav meta GET failed with ${metaResult.status}`);
    error.code = "WEBDAV_HTTP";
    error.status = metaResult.status;
    throw error;
  }
  let meta;
  try {
    meta = JSON.parse(metaResult.body);
  } catch (error) {
    const wrapped = new Error("remote session meta is not valid JSON");
    wrapped.code = "SESSION_SYNC_REMOTE_INVALID";
    throw wrapped;
  }
  if (!meta || typeof meta !== "object" || meta.agent !== agent || meta.session_id !== sessionId) {
    const error = new Error("remote session meta mismatch");
    error.code = "SESSION_SYNC_REMOTE_INVALID";
    throw error;
  }
  const files = [];
  for (const entry of Array.isArray(meta.files) ? meta.files : []) {
    if (!isValidPayloadKey(entry?.key)) {
      const error = new Error(`invalid payload key in remote meta: ${entry?.key}`);
      error.code = "SESSION_SYNC_REMOTE_INVALID";
      throw error;
    }
    const payload = await client.getBinary(payloadPath(directory, machineId, agent, sessionId, entry.key));
    if (payload.notFound) {
      const error = new Error(`remote payload missing: ${entry.key}`);
      error.code = "SESSION_SYNC_REMOTE_MISSING";
      throw error;
    }
    if (!payload.ok) {
      const error = new Error(`webdav payload GET failed with ${payload.status}`);
      error.code = "WEBDAV_HTTP";
      error.status = payload.status;
      throw error;
    }
    const buffer = payload.body;
    const plain = gunzipBuffer(buffer);
    files.push({ key: entry.key, buffer: plain, entry });
  }
  return { meta, files };
}

module.exports = {
  ROOT,
  remoteBase,
  sessionDirPath,
  indexPath,
  metaPath,
  payloadPath,
  normalizeDirectory,
  createClient,
  ensureDeviceCollection,
  uploadBundle,
  deleteBundle,
  fetchRemoteIndexes,
  fetchBundle,
};
