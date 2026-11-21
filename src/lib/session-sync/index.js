"use strict";

// Orchestrator for the manual cross-device conversation sync. Manual-only by
// design (REQUIREMENTS §13): no scheduler, no fs.watch, no timers — every
// network operation runs because the user clicked a button. Owns its own lock
// (<trackerDir>/session-sync/job.lock) so it never blocks or is blocked by
// the statistics sync cycle.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const traffic = require("../webdav/traffic");
const remote = require("./remote");
const store = require("./store");
const usageLog = require("./log");
const {
  sessionSyncDirFor,
  isValidAgent,
  isValidSessionId,
  sha256,
  nowIso,
  MAX_PAYLOAD_BYTES,
} = require("./common");

const codexAdapter = require("./adapters/codex");
const zcodeAdapter = require("./adapters/zcode");
const antigravityAdapter = require("./adapters/antigravity");

const ADAPTERS = {
  codex: codexAdapter,
  zcode: zcodeAdapter,
  antigravity: antigravityAdapter,
};

const instances = new Map();

function adapterFor(agent) {
  const adapter = ADAPTERS[agent];
  if (!adapter) {
    const error = new Error(`unsupported agent: ${agent}`);
    error.code = "SESSION_SYNC_BAD_AGENT";
    throw error;
  }
  return adapter;
}

function newJobId() {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSessionSyncManager({
  trackerDir,
  loadPassword,
  getConfig,
  machineIdProvider,
  fetchImpl,
  homeProvider = () => os.homedir(),
}) {
  if (instances.has(trackerDir)) return instances.get(trackerDir);
  let running = false;
  let currentJob = null;

  async function makeClient() {
    const config = await getConfig();
    if (!config) {
      const error = new Error("webdav not configured");
      error.code = "NOT_CONFIGURED";
      throw error;
    }
    const password = await loadPassword({ username: config.username, url: config.url });
    return {
      client: remote.createClient({ config, password, fetchImpl }),
      config,
    };
  }

  function deviceInfo(config) {
    return {
      name: (typeof config.device_name === "string" && config.device_name.trim()) || os.hostname(),
      platform: os.platform(),
    };
  }

  async function summaryList(registry) {
    return Object.values(registry.uploaded || {})
      .filter((entry) => entry && isValidAgent(entry.agent) && isValidSessionId(entry.sessionId))
      .map((entry) => ({
        agent: entry.agent,
        session_id: entry.sessionId,
        title: entry.title || null,
        cwd: entry.cwd || null,
        project: entry.project || null,
        revision: entry.revision,
        updated_at: entry.uploadedAt,
        bytes: entry.bytes || 0,
      }))
      .sort((a, b) => String(a.agent).localeCompare(String(b.agent)) || String(a.session_id).localeCompare(String(b.session_id)));
  }

  async function runJob(type, items, work) {
    if (running) return { ok: false, code: "BUSY" };
    running = true;
    const job = {
      id: newJobId(),
      type,
      state: "running",
      startedAt: nowIso(),
      items: items.map((item) => ({
        agent: item.agent,
        sessionId: item.sessionId,
        device: item.device || null,
        status: "pending",
      })),
    };
    currentJob = job;
    const jobStartedMs = Date.now();
    await fs.mkdir(sessionSyncDirFor(trackerDir), { recursive: true });
    await usageLog.appendEvent(trackerDir, "job_start", { jobId: job.id, jobType: type, itemCount: job.items.length });
    const { openLock } = require("../fs");
    const lock = await openLock(path.join(sessionSyncDirFor(trackerDir), "job.lock"));
    if (!lock) {
      running = false;
      currentJob = null;
      return { ok: false, code: "BUSY" };
    }
    // The job body runs detached; endpoints return the jobId immediately and
    // the dashboard polls /api/session-sync/status.
    void (async () => {
      try {
        await work(job);
        job.state = job.items.some((item) => item.status === "error") ? "done-with-errors" : "done";
      } catch (error) {
        job.state = "error";
        job.error = { code: error?.code || "SESSION_SYNC_ERROR", message: String(error?.message || error) };
      } finally {
        job.finishedAt = nowIso();
        await store.writeJob(trackerDir, job).catch(() => {});
        await usageLog.appendEvent(trackerDir, "job_end", {
          jobId: job.id,
          jobType: job.type,
          status: job.state,
          durationMs: Date.now() - jobStartedMs,
          doneCount: job.items.filter((item) => item.status === "done").length,
          errorCount: job.items.filter((item) => item.status === "error").length,
          ...(job.error?.code ? { code: job.error.code } : {}),
        });
        // Bytes were on the wire whether the job succeeded or not; same flush
        // contract as the statistics scheduler.
        const spent = traffic.snapshot();
        if (spent.uploaded > 0 || spent.downloaded > 0) {
          await traffic.flush(trackerDir).catch(() => {});
        }
        await lock.release().catch(() => {});
        running = false;
      }
    })();
    await store.writeJob(trackerDir, job).catch(() => {});
    return { ok: true, jobId: job.id };
  }

  async function listLocal() {
    const home = homeProvider();
    const registry = await store.readRegistry(trackerDir);
    const items = [];
    for (const adapter of Object.values(ADAPTERS)) {
      try {
        const conversations = await adapter.listConversations(
          adapter === codexAdapter ? { home } : { home, env: process.env },
        );
        items.push(...conversations);
      } catch (error) {
        items.push({
          agent: adapter.AGENT,
          listError: { code: error?.code || "SESSION_SYNC_LIST_FAILED", message: String(error?.message || error) },
        });
      }
    }
    const uploadedMap = registry.uploaded || {};
    for (const item of items) {
      if (!item.sessionId) continue;
      const uploaded = uploadedMap[`${item.agent}:${item.sessionId}`];
      item.upload = uploaded ? {
        revision: uploaded.revision,
        uploadedAt: uploaded.uploadedAt,
        hasChanges: uploaded.sha256Plain ? true : false,
      } : null;
    }
    const importedMap = registry.imported || {};
    return {
      items,
      imported: Object.entries(importedMap).map(([key, entry]) => ({
        agent: entry.agent,
        sessionId: entry.sessionId,
        originDevice: entry.originDevice,
        revision: entry.revision,
        importedAt: entry.importedAt,
      })),
    };
  }

  async function startUpload(items) {
    const normalized = (Array.isArray(items) ? items : [])
      .filter((item) => isValidAgent(item?.agent) && isValidSessionId(item?.sessionId));
    if (normalized.length === 0) return { ok: false, code: "SESSION_SYNC_NO_ITEMS" };
    // Refuse before spawning a doomed job when WebDAV is not set up at all.
    if (!(await getConfig())) return { ok: false, code: "NOT_CONFIGURED" };
    return runJob("upload", normalized, async (job) => {
      const { client, config } = await makeClient();
      const machineId = await machineIdProvider();
      const directory = remote.normalizeDirectory(config.directory);
      const info = deviceInfo(config);
      const home = homeProvider();
      for (const jobItem of job.items) {
        jobItem.status = "working";
        await store.writeJob(trackerDir, job).catch(() => {});
        let prepared = null;
        try {
          const adapter = adapterFor(jobItem.agent);
          prepared = await adapter.prepareUpload(
            adapter === codexAdapter
              ? { home, trackerDir, sessionId: jobItem.sessionId }
              : adapter === antigravityAdapter
                ? { home, env: process.env, trackerDir, sessionId: jobItem.sessionId }
                : { home, env: process.env, sessionId: jobItem.sessionId },
          );
          let totalBytes = 0;
          for (const file of prepared.files) {
            if (sha256(file.buffer) !== file.sha256) {
              const error = new Error("payload digest mismatch before upload");
              error.code = "SESSION_SYNC_DIGEST_MISMATCH";
              throw error;
            }
            totalBytes += file.bytes;
            if (file.bytes > MAX_PAYLOAD_BYTES) {
              const error = new Error("payload exceeds the 100MB limit");
              error.code = "SESSION_SYNC_PAYLOAD_TOO_LARGE";
              throw error;
            }
          }
          const registry = await store.readRegistry(trackerDir);
          const key = `${jobItem.agent}:${jobItem.sessionId}`;
          const prior = registry.uploaded[key];
          const revision = (Number(prior?.revision) || 0) + 1;
          const sha256Plain = prepared.files.length === 1
            ? prepared.files[0].sha256
            : hashFileSet(prepared.files);
          // Index summaries are computed from the projected next registry
          // state, but the registry itself only advances after a confirmed
          // upload — a failed transfer leaves the previous revision intact.
          const projected = {
            ...registry,
            uploaded: {
              ...registry.uploaded,
              [key]: {
                agent: jobItem.agent,
                sessionId: jobItem.sessionId,
                revision,
                title: prepared.meta.title || prior?.title || null,
                cwd: prepared.meta.cwd || prior?.cwd || null,
                project: prepared.meta.project || prior?.project || null,
                bytes: totalBytes,
                sha256Plain,
                uploadedAt: nowIso(),
              },
            },
          };
          await remote.uploadBundle(client, {
            directory,
            machineId,
            agent: jobItem.agent,
            sessionId: jobItem.sessionId,
            meta: { ...prepared.meta, revision, device: info },
            files: prepared.files,
            summaries: await summaryList(projected),
          });
          await store.updateRegistry(trackerDir, (current) => {
            current.uploaded[key] = projected.uploaded[key];
            return current;
          });
          jobItem.status = "done";
          jobItem.bytes = totalBytes;
          jobItem.revision = revision;
        } catch (error) {
          jobItem.status = "error";
          jobItem.code = error?.code || "SESSION_SYNC_ERROR";
          jobItem.message = safeMessage(error);
        }
        await usageLog.appendEvent(trackerDir, "item_result", {
          jobId: job.id,
          agent: jobItem.agent,
          sessionId: jobItem.sessionId,
          title: prepared?.meta?.title || null,
          status: jobItem.status,
          ...(jobItem.code ? { code: jobItem.code } : {}),
          ...(jobItem.message ? { message: jobItem.message } : {}),
          ...(jobItem.bytes ? { bytes: jobItem.bytes } : {}),
          ...(jobItem.revision ? { revision: jobItem.revision } : {}),
        });
        await store.writeJob(trackerDir, job).catch(() => {});
      }
    });
  }

  async function refreshRemote() {
    if (running) return { ok: false, code: "BUSY" };
    running = true;
    const { openLock } = require("../fs");
    await fs.mkdir(sessionSyncDirFor(trackerDir), { recursive: true });
    const lock = await openLock(path.join(sessionSyncDirFor(trackerDir), "job.lock"));
    if (!lock) {
      running = false;
      return { ok: false, code: "BUSY" };
    }
    try {
      const { client, config } = await makeClient();
      const machineId = await machineIdProvider();
      const directory = remote.normalizeDirectory(config.directory);
      const { devices } = await remote.fetchRemoteIndexes(client, { directory, ownMachineId: machineId });
      await store.updateRegistry(trackerDir, (current) => {
        current.remoteCache = { fetchedAt: nowIso(), devices };
        return current;
      });
      await usageLog.appendEvent(trackerDir, "refresh", {
        deviceCount: Object.keys(devices).length,
        sessionCount: Object.values(devices).reduce((sum, device) => sum + (device.sessions?.length || 0), 0),
      });
      return { ok: true, fetchedAt: nowIso(), devices };
    } finally {
      const spent = traffic.snapshot();
      if (spent.uploaded > 0 || spent.downloaded > 0) await traffic.flush(trackerDir).catch(() => {});
      await lock.release().catch(() => {});
      running = false;
    }
  }

  async function remoteListing() {
    const registry = await store.readRegistry(trackerDir);
    const cache = registry.remoteCache || { fetchedAt: null, devices: {} };
    const imported = registry.imported || {};
    const devices = {};
    for (const [machineId, device] of Object.entries(cache.devices || {})) {
      devices[machineId] = {
        name: device.name,
        platform: device.platform,
        sessions: (device.sessions || []).map((session) => {
          const entry = imported[`${session.agent}:${session.session_id}`];
          return {
            ...session,
            imported: entry ? {
              revision: entry.revision,
              importedAt: entry.importedAt,
              hasUpdate: Number(session.revision) > Number(entry.revision || 0),
            } : null,
          };
        }),
      };
    }
    return { fetchedAt: cache.fetchedAt, devices };
  }

  async function startImport(items) {
    const normalized = (Array.isArray(items) ? items : [])
      .filter((item) => isValidAgent(item?.agent) && isValidSessionId(item?.sessionId)
        && typeof item?.device === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(item.device));
    if (normalized.length === 0) return { ok: false, code: "SESSION_SYNC_NO_ITEMS" };
    return runJob("import", normalized, async (job) => {
      const { client, config } = await makeClient();
      const machineId = await machineIdProvider();
      const directory = remote.normalizeDirectory(config.directory);
      const home = homeProvider();
      const backupsDir = await store.prepareBackupDir(trackerDir);
      for (const jobItem of job.items) {
        jobItem.status = "working";
        await store.writeJob(trackerDir, job).catch(() => {});
        let bundle = null;
        let result = null;
        try {
          bundle = await remote.fetchBundle(client, {
            directory,
            machineId: jobItem.device,
            agent: jobItem.agent,
            sessionId: jobItem.sessionId,
          });
          for (const file of bundle.files) {
            const digest = sha256(file.buffer);
            if (!file.entry || digest !== file.entry.sha256 || file.buffer.byteLength !== file.entry.bytes) {
              const error = new Error(`payload digest mismatch: ${file.key}`);
              error.code = "SESSION_SYNC_DIGEST_MISMATCH";
              throw error;
            }
            if (file.buffer.byteLength > MAX_PAYLOAD_BYTES) {
              const error = new Error("payload exceeds the 100MB limit");
              error.code = "SESSION_SYNC_PAYLOAD_TOO_LARGE";
              throw error;
            }
          }
          const registry = await store.readRegistry(trackerDir);
          const prior = registry.imported[`${jobItem.agent}:${jobItem.sessionId}`];
          const adapter = adapterFor(jobItem.agent);
          result = await adapter.importBundle(
            adapter === codexAdapter
              ? { home, trackerDir, files: bundle.files, meta: bundle.meta, backupsDir, priorSha256: prior?.sha256Plain }
              : adapter === antigravityAdapter
                ? { home, env: process.env, trackerDir, files: bundle.files, meta: bundle.meta, backupsDir, priorSha256: prior?.sha256Plain }
                : { home, env: process.env, files: bundle.files, meta: bundle.meta, priorImport: Boolean(prior) },
          );
          if (jobItem.agent === "zcode" && Array.isArray(result.insertedMessageIds) && result.insertedMessageIds.length > 0) {
            await store.appendImportedMessageIds(trackerDir, result.insertedMessageIds);
          }
          await store.recordImport(trackerDir, jobItem.agent, jobItem.sessionId, {
            agent: jobItem.agent,
            sessionId: jobItem.sessionId,
            originDevice: jobItem.device,
            revision: bundle.meta.revision,
            sha256Plain: result.sha256Plain,
          });
          jobItem.status = "done";
          jobItem.bytes = result.bytes;
          jobItem.revision = bundle.meta.revision;
          if (result.backupPath) jobItem.backup = true;
        } catch (error) {
          jobItem.status = "error";
          jobItem.code = error?.code || "SESSION_SYNC_ERROR";
          jobItem.message = safeMessage(error);
        }
        await usageLog.appendEvent(trackerDir, "item_result", {
          jobId: job.id,
          agent: jobItem.agent,
          sessionId: jobItem.sessionId,
          device: jobItem.device,
          title: bundle?.meta?.title || null,
          status: jobItem.status,
          ...(jobItem.code ? { code: jobItem.code } : {}),
          ...(jobItem.message ? { message: jobItem.message } : {}),
          ...(jobItem.bytes ? { bytes: jobItem.bytes } : {}),
          ...(jobItem.revision ? { revision: jobItem.revision } : {}),
          ...(jobItem.backup ? { backup: true } : {}),
          ...(result?.insertedMessageIds ? { insertedMessages: result.insertedMessageIds.length } : {}),
        });
        await store.writeJob(trackerDir, job).catch(() => {});
      }
    });
  }

  async function deleteRemote(agent, sessionId) {
    if (!isValidAgent(agent) || !isValidSessionId(sessionId)) {
      return { ok: false, code: "SESSION_SYNC_BAD_REQUEST" };
    }
    if (running) return { ok: false, code: "BUSY" };
    running = true;
    const { openLock } = require("../fs");
    const lock = await openLock(path.join(sessionSyncDirFor(trackerDir), "job.lock"));
    if (!lock) {
      running = false;
      return { ok: false, code: "BUSY" };
    }
    try {
      const { client, config } = await makeClient();
      const machineId = await machineIdProvider();
      const directory = remote.normalizeDirectory(config.directory);
      const nextRegistry = await store.updateRegistry(trackerDir, (current) => {
        delete current.uploaded[`${agent}:${sessionId}`];
        return current;
      });
      await remote.deleteBundle(client, {
        directory,
        machineId,
        agent,
        sessionId,
        summaries: await summaryList(nextRegistry),
      });
      await usageLog.appendEvent(trackerDir, "delete", { agent, sessionId });
      return { ok: true };
    } finally {
      const spent = traffic.snapshot();
      if (spent.uploaded > 0 || spent.downloaded > 0) await traffic.flush(trackerDir).catch(() => {});
      await lock.release().catch(() => {});
      running = false;
    }
  }

  async function status() {
    const job = currentJob || await store.readJob(trackerDir);
    const registry = await store.readRegistry(trackerDir);
    return {
      job: job ? {
        id: job.id,
        type: job.type,
        state: job.state,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt || null,
        error: job.error || null,
        items: job.items,
      } : null,
      uploadedCount: Object.keys(registry.uploaded || {}).length,
      importedCount: Object.keys(registry.imported || {}).length,
      remoteFetchedAt: registry.remoteCache?.fetchedAt || null,
    };
  }

  const manager = {
    listLocal,
    startUpload,
    refreshRemote,
    remoteListing,
    startImport,
    deleteRemote,
    status,
  };
  instances.set(trackerDir, manager);
  return manager;
}

function hashFileSet(files) {
  return sha256(Buffer.from(files.map((file) => file.sha256).join("\n"), "utf8"));
}

function safeMessage(error) {
  const message = String(error?.message || error || "");
  // Never let credentials or absolute remote URLs leak into job/status output.
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300);
}

module.exports = { createSessionSyncManager, ADAPTERS };
