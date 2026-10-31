// WebDAV sync scheduler — runs inside the local serve process (never a
// separate daemon). Owns the sync cycle described in SYNC_DESIGN §5:
//
//   export (own device docs, only on content change)
//   → import (other devices' new segments)
//   → update state.json (last success / failure / backoff)
//
// Failure handling: network/5xx failures back off exponentially
// (1m → 5m → 15m → 60m cap); 401 pauses automatic retries but manual
// sync-now always works. Local collection and viewing never depend on this
// loop succeeding.

const fs = require("node:fs/promises");
const path = require("node:path");

const { WebDavClient } = require("./client");
const {
  serializeDocument,
  parseDocument,
  baseFileName,
  segmentFileName,
  parseDocFileName,
} = require("../sync-store/format");
const exporter = require("../sync-store/exporter");
const { createDeviceImportStore, mergeBucketsAcrossDevices } = require("../sync-store/importer");

const DEFAULT_INTERVAL_MINUTES = 5;
// Personal usage changes on a minutes scale; the change-detection means an
// unchanged cycle costs one PROPFIND per device, which keeps request volume
// well inside WebDAV providers' rate limits (e.g. jianguiyun's per-request
// quotas). 5 minutes balances freshness against that budget.
const BACKOFF_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const SEGMENTS_BEFORE_BASE = 20;
const BASES_TO_KEEP = 3;

function webdavDirFor(trackerDir) {
  return path.join(trackerDir, "webdav");
}

// Per-kind record of what this device last PUBLISHED successfully. Unlike the
// locally observed union (fork-history/wire-<kind>.json), it only advances
// after a confirmed upload, so retries, crashes between the upload and the
// local commit, and restore/rebase paths can never skip an unsent revision.
function publishedPathFor(trackerDir, kind) {
  return path.join(webdavDirFor(trackerDir), "published", `${kind}.json`);
}
// Key-order-insensitive row identity. Rows recovered from the server come
// back re-shaped by the import sanitizer, so a plain JSON.stringify would
// flag every recovered row as changed forever; canonical hashing compares
// content, not construction order.
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
};
const rowHash = (row) =>
  require("node:crypto").createHash("sha256").update(JSON.stringify(canonicalize(row))).digest("hex");
async function loadPublishedBaseline(trackerDir, kind) {
  try {
    const baseline = JSON.parse(await fs.readFile(publishedPathFor(trackerDir, kind), "utf8"));
    if (
      !baseline ||
      !Number.isSafeInteger(baseline.seq) ||
      !baseline.hashes ||
      typeof baseline.hashes !== "object"
    )
      return null;
    return baseline;
  } catch {
    return null;
  }
}
async function savePublishedBaseline(trackerDir, kind, baseline) {
  await writeJsonAtomic(publishedPathFor(trackerDir, kind), baseline);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const username = typeof raw.username === "string" ? raw.username.trim() : "";
  const directory = typeof raw.directory === "string" && raw.directory.trim()
    ? raw.directory.trim().replace(/^\/+|\/+$/g, "")
    : "tokentracker-fork";
  const deviceName = typeof (raw.device_name || raw.deviceName) && typeof (raw.device_name || raw.deviceName) === "string"
    ? (raw.device_name || raw.deviceName).trim()
    : null;
  const enabled = raw.enabled !== false;
  if (!/^https:\/\/|^http:\/\/localhost(:|$)|^http:\/\/127\.0\.0\.1(:|$)/.test(url)) {
    return null; // HTTPS required outside local test servers
  }
  if (!username) return null;
  try { const u = new URL(url); if (u.username || u.password || u.search || u.hash) return null; } catch {return null;}
  if (directory.split('/').some(part => !part || part === '.' || part === '..' || /[\\?#%]/.test(part))) return null;
  return {
    url: url.replace(/\/+$/, ""),
    username,
    directory,
    deviceName,
    enabled,
    syncTitles: raw.sync_titles !== false && raw.syncTitles !== false,
    intervalMinutes: Number(raw.interval_minutes || raw.intervalMinutes) > 0 ? Math.max(1, Number(raw.interval_minutes || raw.intervalMinutes)) : DEFAULT_INTERVAL_MINUTES,
  };
}

// ---------------------------------------------------------------------------
// One sync cycle. Pure with respect to injected collaborators; persists only
// through the passed stores so tests can drive it against fixtures.
// ---------------------------------------------------------------------------

async function runSyncCycle({
  config,
  password,
  machineId,
  trackerDir,
  state, // current state object (mutated and returned)
  client, // optional injected WebDavClient
  fetchImpl,
  now = () => Date.now(),
}) {
  const normalized = normalizeConfig(config);
  if (!normalized) {
    return { ok: false, code: "INVALID_CONFIG", state };
  }
  if (!normalized.enabled) {
    return { ok: true, skipped: "disabled", state };
  }
  if (!password) {
    return { ok: false, code: "MISSING_CREDENTIAL", state };
  }

  const dav = client || new WebDavClient({
    baseUrl: normalized.url,
    username: normalized.username,
    password,
    fetchImpl,
  });
  const rootDir = normalized.directory;
  const deviceDir = `${rootDir}/devices/${machineId}`;
  const importsDir = path.join(webdavDirFor(trackerDir), "imports");
  const notes = [];

  // --- export -------------------------------------------------------------
  const queuePath = path.join(trackerDir, "queue.jsonl");
  const projectQueuePath = path.join(trackerDir, "project.queue.jsonl");

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(machineId || '')) throw new Error('invalid device identity');
  const ensured = await dav.ensureCollection(deviceDir);
  if (!ensured.ok) throw Object.assign(new Error(`collection failed (${ensured.status})`), {status:ensured.status,code:[401,403].includes(ensured.status)?'WEBDAV_UNAUTHORIZED':'WEBDAV_HTTP',retryAfterMs:ensured.retryAfterMs});

  const remoteOwnFiles = await dav.list(deviceDir);
  if (!remoteOwnFiles.ok) {
    throw Object.assign(new Error(`export listing failed (${remoteOwnFiles.status})`), {
      code: remoteOwnFiles.status === 401 ? "WEBDAV_UNAUTHORIZED" : "WEBDAV_HTTP",
      status: remoteOwnFiles.status,
      retryAfterMs:remoteOwnFiles.retryAfterMs,
    });
  }
  const kinds = ["buckets", "projects", "sessions", "prefs"];
  const serverSeqs = Object.fromEntries(kinds.map(k=>[k,0]));
  const remoteSegmentsSinceBase = Object.fromEntries(kinds.map(k=>[k,0]));
  const remoteBases = Object.fromEntries(kinds.map(k=>[k,[]]));
  for (const entry of remoteOwnFiles.entries) {
    const parsed = parseDocFileName(entry.name);
    if (!parsed || !kinds.includes(parsed.kind)) continue;
    if (parsed.seq > (serverSeqs[parsed.kind] || 0)) serverSeqs[parsed.kind] = parsed.seq;
    if (parsed.variant === "seg") remoteSegmentsSinceBase[parsed.kind] += 1;
    else remoteBases[parsed.kind].push({ seq: parsed.seq, name: entry.name });
  }

  const durable = require('../fork-store');
  const privacy = require('../sync-store/privacy');
  const keyOf = require('../sync-store/importer');
  const sessionRows = await require('../fork-view').collectSessions(trackerDir, {home:path.dirname(path.dirname(trackerDir))});
  const local = {
    buckets: await require("../fork-costs").capture(trackerDir,exporter.buildBucketsRows({queuePath,machineId})),
    projects: exporter.buildProjectsRows({projectQueuePath,machineId}),
    sessions: require("../session-analytics").mergeSessionFragments(sessionRows).map(row=>privacy.session(row,machineId,{syncTitles:normalized.syncTitles})),
    prefs: (await require('../fork-prefs').local(trackerDir)).map(require('../fork-prefs').sanitize),
  };
  const keys = {buckets:exporter.bucketRowKey,projects:exporter.projectRowKey,sessions:r=>r.session_hash,prefs:r=>r.id};
  state.input_hashes=state.input_hashes||{};
  const exportPlan = [];
  for (const kind of kinds) {
    state.input_hashes[kind]=exporter.stableRowsHash(local[kind]);
    // The publish baseline records the content this device last CONFIRMED
    // uploading. Delta segments are computed against it; recovery kicks in
    // whenever the retained union no longer covers the published keys (wiped
    // history) or the server is ahead in a way the baseline cannot vouch for.
    const published = await loadPublishedBaseline(trackerDir, kind);
    let rows = await durable.retain(trackerDir,`wire-${kind}`,local[kind],keys[kind]);
    const rowKeySet = new Set(rows.map((row) => keys[kind](row)));
    const missingPublishedRows = Boolean(
      published && Object.keys(published.hashes).some((key) => !rowKeySet.has(key)),
    );
    const serverMatchesPublished = Boolean(
      published && published.seq === serverSeqs[kind] && serverSeqs[kind] > 0 && !missingPublishedRows,
    );
    // Recover own last remote view BEFORE rebase after a restored backup.
    const restored = (Number(state.docs?.[kind]?.seq || 0) < serverSeqs[kind] && !serverMatchesPublished) || missingPublishedRows;
    let recovered = [];
    if (restored) {
      const ownStore = createDeviceImportStore({importsDir:path.join(webdavDirFor(trackerDir),'recovery'),machineId});
      const ownFiles = remoteOwnFiles.entries.map(e=>({name:e.name,parsed:parseDocFileName(e.name)})).filter(e=>e.parsed?.kind===kind).sort((a,b)=>a.parsed.seq-b.parsed.seq);
      const base = ownFiles.filter(e=>e.parsed.variant==='base').at(-1);
      for (const file of ownFiles.filter(e=>!base || e.parsed.seq>=base.parsed.seq)) {
        const got = await dav.get(`${deviceDir}/${file.name}`);
        if (!got.ok || !got.body) throw new Error('own snapshot recovery failed');
        const doc = parseDocument(got.body);
        if (doc.header.kind !== kind || doc.header.seq !== file.parsed.seq) throw new Error('recovery manifest mismatch');
        await ownStore.applyDocument(doc);
      }
      recovered = await ownStore[{buckets:'readMergedBuckets',projects:'readMergedProjects',sessions:'readMergedSessions',prefs:'readMergedPrefs'}[kind]]();
      // Newer remote values win over an older local backup on collisions.
      local[kind] = [...new Map([...local[kind],...recovered].map(r=>[keys[kind](r),r])).values()];
      rows = await durable.retain(trackerDir,`wire-${kind}`,local[kind],keys[kind]);
      notes.push(`rebased ${kind} after device restore`);
    }
    const hash = exporter.stableRowsHash(rows);
    const lastSeq = Math.max(Number(state.docs?.[kind]?.seq || 0), serverSeqs[kind]);
    const lastHash = state.docs?.[kind]?.hash;
    if (hash === lastHash && lastSeq > 0 && !state.force_base && !restored) {
      continue; // no change, no upload
    }
    const nextSeq = lastSeq + 1;
    // Delta segments are computed against the last SUCCESSFULLY published row
    // set. A missing or out-of-date baseline (first export after this feature,
    // restore from backup) forces a full base once; from then on segments
    // carry only changed rows.
    const baselineUsable = Boolean(published && published.seq === lastSeq);
    // Re-base when the segment chain grows too long, after a device restore
    // (server seq ahead of local state), on first export, or without a usable
    // publish baseline.
    let rebase = state.force_base || restored || lastSeq === 0 || remoteSegmentsSinceBase[kind] >= SEGMENTS_BEFORE_BASE || !baselineUsable;
    let segRows = rows;
    if (!rebase) {
      segRows = rows.filter((row) => published.hashes[keys[kind](row)] !== rowHash(row));
      if (!segRows.length) {
        // The union hash moved (e.g. reordering) but no row content differs
        // from what the server already holds — record the hash, upload nothing.
        state.docs = state.docs || {};
        state.docs[kind] = { seq: lastSeq, hash, at: new Date(now()).toISOString() };
        continue;
      }
    }
    const fileName = rebase ? baseFileName(kind, nextSeq) : segmentFileName(kind, nextSeq);
    exportPlan.push({
      kind,
      rows: rebase ? rows : segRows,
      hash,
      seq: nextSeq,
      rebase,
      fileName,
      sinceSeq: rebase ? null : lastSeq,
      baseline: published,
    });
  }

  // A transient connection reset mid-upload (the dominant real-world sync
  // failure on consumer cloud drives, seen as WEBDAV_NETWORK on PUT) used to
  // kill the whole cycle and push the next attempt a full backoff out. The
  // publish is idempotent (unique part name + MOVE), so one immediate retry
  // converts most blips into an invisible recovery.
  const TRANSIENT_UPLOAD_CODES = new Set(["WEBDAV_NETWORK", "WEBDAV_TIMEOUT"]);
  const uploadWithRetry = async (name, content, label) => {
    try {
      return await dav.putAtomic(name, content);
    } catch (error) {
      if (!TRANSIENT_UPLOAD_CODES.has(error?.code)) throw error;
      notes.push(`${label} hit ${error.code}; retrying once`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return dav.putAtomic(name, content);
    }
  };

  for (const plan of exportPlan) {
    const content = serializeDocument({
      kind: plan.kind,
      device: machineId,
      seq: plan.seq,
      sinceSeq: plan.sinceSeq,
      rows: plan.rows,
    });
    const put = await uploadWithRetry(`${deviceDir}/${plan.fileName}`, content, `upload ${plan.kind}`);
    if (!put.ok) {
      throw Object.assign(new Error(`upload ${plan.kind} failed (${put.status})`), {
        code: put.status === 401 ? "WEBDAV_UNAUTHORIZED" : "WEBDAV_UPLOAD_FAILED",
        status: put.status,
        retryAfterMs: put.retryAfterMs,
      });
    }
    state.docs = state.docs || {};
    state.docs[plan.kind] = { seq: plan.seq, hash: plan.hash, at: new Date(now()).toISOString() };
    // Only after a confirmed upload does the publish baseline advance. A
    // failure or crash before this line leaves the baseline stale, so the
    // next cycle re-sends the affected rows (never skips them).
    const baseline = plan.rebase
      ? { seq: plan.seq, hashes: Object.fromEntries(plan.rows.map((row) => [keys[plan.kind](row), rowHash(row)])) }
      : {
          seq: plan.seq,
          hashes: {
            ...(plan.baseline?.hashes || {}),
            ...Object.fromEntries(plan.rows.map((row) => [keys[plan.kind](row), rowHash(row)])),
          },
        };
    await savePublishedBaseline(trackerDir, plan.kind, baseline);
    notes.push(`exported ${plan.kind} seq ${plan.seq}${plan.rebase ? " (base)" : ""}`);

    // Bounded history housekeeping on our OWN files only: after publishing a
    // new base, older segments and surplus bases may go.
    if (plan.rebase) {
      const cleanable = [...remoteOwnFiles.entries]
        .map((entry) => ({ entry, parsed: parseDocFileName(entry.name) }))
        .filter(({ parsed }) => parsed && parsed.kind === plan.kind && parsed.seq < plan.seq)
        .sort((a, b) => a.parsed.seq - b.parsed.seq);
      const bases = cleanable.filter(({ parsed }) => parsed.variant === "base");
      const basesToRemove = new Set(
        bases.slice(0, Math.max(0, bases.length - (BASES_TO_KEEP - 1))).map(({ entry }) => entry.name),
      );
      for (const { entry, parsed } of cleanable) {
        if (parsed.variant === "seg" || basesToRemove.has(entry.name)) {
          await dav.delete(`${deviceDir}/${entry.name}`).catch(() => {});
        }
      }
    }
  }
  state.force_base = false;

  // device.json — device name/platform for the dashboard device list. Small
  // and mutable, so a plain PUT is fine; only append-critical documents need
  // the atomic part+MOVE publish.
  const deviceDoc = {
    format: 1,
    id: machineId,
    name: normalized.deviceName || machineId,
    platform: process.platform,
    app_version: readAppVersion(),
    updated_at: new Date(now()).toISOString(),
  };
  const deviceHash = exporter.stableRowsHash([{...deviceDoc,updated_at:null}]);
  if (state.device_hash !== deviceHash || exportPlan.length) {
    let devicePut;
    try {
      devicePut = await dav.put(`${deviceDir}/device.json`, JSON.stringify(deviceDoc, null, 2) + "\n");
    } catch (error) {
      if (!TRANSIENT_UPLOAD_CODES.has(error?.code)) throw error;
      notes.push(`device.json hit ${error.code}; retrying once`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      devicePut = await dav.put(`${deviceDir}/device.json`, JSON.stringify(deviceDoc, null, 2) + "\n");
    }
    if (!devicePut.ok) throw Object.assign(new Error(`device.json upload failed (${devicePut.status})`), {code:[401,403].includes(devicePut.status)?'WEBDAV_UNAUTHORIZED':'WEBDAV_UPLOAD_FAILED',status:devicePut.status,retryAfterMs:devicePut.retryAfterMs});
    state.device_hash = deviceHash;
  }

  // --- import -------------------------------------------------------------
  const devicesListing = await dav.list(`${rootDir}/devices`);
  if (!devicesListing.ok) {
    throw Object.assign(new Error(`device listing failed (${devicesListing.status})`), {
      code: devicesListing.status === 401 ? "WEBDAV_UNAUTHORIZED" : "WEBDAV_HTTP",
      status: devicesListing.status,
      retryAfterMs:devicesListing.retryAfterMs,
    });
  }
  const imported = {};
  const listedPath = normalizeCollectionHref(decodeURIComponent(new URL(`${dav.base}/${rootDir}/devices`).pathname));
  for (const entry of devicesListing.entries) {
    if (!entry.isCollection) continue;
    if (normalizeCollectionHref(decodeURIComponent(new URL(entry.href,dav.base).pathname)) === listedPath) continue; // the listing's own row
    const remoteMachineId = entry.name;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(remoteMachineId)) continue;
    if (remoteMachineId === machineId) continue;
    const store = createDeviceImportStore({ importsDir, machineId: remoteMachineId });
    const highWater = await store.highWater();
    const docs = await dav.list(`${rootDir}/devices/${remoteMachineId}`);
    if (!docs.ok) {
      imported[remoteMachineId] = { ok: false, status: docs.status, code: 'WEBDAV_HTTP' };
      notes.push(`import listing failed for ${remoteMachineId}`);
      continue;
    }
    const files = docs.entries
      .map((fileEntry) => ({ name: fileEntry.name, etag:fileEntry.etag, parsed: parseDocFileName(fileEntry.name) }))
      .filter(({ parsed }) => parsed && kinds.includes(parsed.kind))
      .sort((a, b) => a.parsed.seq - b.parsed.seq);
    // Only the highest base PER KIND matters; older bases of the same kind are
    // superseded (their rows ride the newest base).
    const highestBaseByKind = new Map();
    for (const file of files) {
      if (file.parsed.variant !== "base") continue;
      const current = highestBaseByKind.get(file.parsed.kind);
      if (!current || file.parsed.seq > current.parsed.seq) highestBaseByKind.set(file.parsed.kind, file);
    }
    let appliedAny = false;
    let failedAny = false, failure = null;
    for (const file of files) {
      if (file.parsed.variant === "base" && highestBaseByKind.get(file.parsed.kind) !== file) continue;
      if (file.parsed.seq < (highWater[file.parsed.kind] || 0)) continue;
      state.receipts=state.receipts||{};state.receipts[remoteMachineId]=state.receipts[remoteMachineId]||{};
      const receipt=state.receipts[remoteMachineId];
      if(file.parsed.seq === (highWater[file.parsed.kind]||0) && file.etag && receipt[file.name]===file.etag)continue;
      const got = await dav.get(`${rootDir}/devices/${remoteMachineId}/${file.name}`);
      if (!got.ok || got.notFound || got.body == null) {
        failedAny = true;
        failure = { code: 'WEBDAV_HTTP', status: got.status };
        continue;
      }
      try {
        const doc = parseDocument(got.body);
        if (doc.header.device !== remoteMachineId || doc.header.kind !== file.parsed.kind || doc.header.seq !== file.parsed.seq || (file.parsed.variant === 'base') !== (doc.header.since_seq == null)) throw new Error('manifest/content mismatch');
        const applied=await store.applyDocument(doc);
        if(file.etag)receipt[file.name]=file.etag;
        appliedAny = appliedAny || applied.applied;
      } catch (error) {
        // Corrupt/half file: skip and report; the device's next export or the
        // base rebuild repairs it. Never abort the whole import.
        failedAny = true;
        failure = { code: 'WEBDAV_INVALID_DOCUMENT' };
        notes.push(`skipped corrupt ${remoteMachineId}/${file.name}: ${error.reason || error.message}`);
      }
    }
    const info = await dav.get(`${rootDir}/devices/${remoteMachineId}/device.json`);
    if (info.ok && info.body) {
      try {
        await store.saveDeviceInfo(JSON.parse(info.body));
      } catch { /* non-fatal */ }
    }
    imported[remoteMachineId] = { ok: !failedAny, updated: appliedAny, ...(failure || {}) };
  }

  state.imported = imported;
  state.paused_auth = false;
  state.partial = Object.values(imported).some(v=>!v.ok);
  if (!state.partial) state.last_success_at = new Date(now()).toISOString();
  state.last_failure = null;
  state.backoff_step = 0;
  state.backoff_until_ms = 0;
  state.notes = notes.slice(-20);
  return { ok: true, partial: state.partial, exported: exportPlan.map((plan) => plan.kind), imported, state };
}

function normalizeCollectionHref(href) {
  return String(href || "").replace(/\/+$/, "");
}

function joinCollectionPath(p) {
  return normalizeCollectionHref(p);
}

function readAppVersion() {
  try {
    return require("../../../package.json").version;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Long-running scheduler (used by the serve process).
// ---------------------------------------------------------------------------

const instances = new Map();
function createWebdavScheduler({ trackerDir, loadPassword, getConfig, machineIdProvider, fetchImpl }) {
  if (instances.has(trackerDir)) return instances.get(trackerDir);
  let timer = null;
  let watcher = null;
  let debounce = null;
  let epoch = 0;
  let running = false;
  let cycleLock = null;
  const statePath = path.join(webdavDirFor(trackerDir), "state.json");

  async function readState() {
    return readJson(statePath, { version: 1, docs: {}, imported: {}, notes: [] });
  }

  async function persistState(state) {
    await writeJsonAtomic(statePath, state);
  }

  async function cycle({ manual = false } = {}) {
    if (running) return { ok: true, skipped: "already-running" };
    running = true;
    try {
      await fs.mkdir(webdavDirFor(trackerDir),{recursive:true});
      cycleLock = await require("../fs").openLock(path.join(webdavDirFor(trackerDir),"sync.lock"));
      if (!cycleLock) return {ok:true,skipped:"another-process-running"};
      const config = await getConfig();
      if (!config) return {ok:true,skipped:"not-configured"};
      const normalized = normalizeConfig(config);
      if (!normalized) {
        const state = await readState();
        state.last_failure = { at: new Date().toISOString(), code: "INVALID_CONFIG" };
        await persistState(state);
        return { ok: false, code: "INVALID_CONFIG" };
      }
      if (!normalized.enabled && !manual) return { ok: true, skipped: "disabled" };
      const state = await readState();
      // A failure schedules a retry at the backoff expiry, independent of the
      // normal interval. Once that time arrives the cycle must run even if
      // the regular interval has not elapsed (30-minute interval + 1-minute
      // backoff must retry near the backoff, not at the next interval).
      const pendingRetryMs = Number(state.next_attempt_ms || 0);
      if (!manual && pendingRetryMs > Date.now()) return { ok: true, skipped: "backoff" };
      if (!manual && state.paused_auth) return { ok: true, skipped: "auth-paused" };
      const lastAttemptMs = Date.parse(state.last_attempt_at || state.last_success_at || "");
      const elapsed = Date.now() - lastAttemptMs;
      if (!manual && !pendingRetryMs && Number.isFinite(lastAttemptMs) && elapsed >= 0 && elapsed < intervalMs(config)) {
        return { ok: true, skipped: "interval" };
      }
      // Polling, file-change debounce and restarted processes share the same
      // cadence. Manual sync bypasses it; Retry-After/auth backoff still applies
      // to every automatic trigger.
      state.last_attempt_at = new Date().toISOString();
      await persistState(state);
      const machineId = await machineIdProvider();
      const password = await loadPassword({ username: normalized.username, trackerDir, url:normalized.url });
      const result = await runSyncCycle({
        config: { ...config, enabled: manual ? true : config.enabled },
        password,
        machineId,
        trackerDir,
        state,
        fetchImpl,
      });
      if(result.ok === false) {state.last_failure={at:new Date().toISOString(),code:result.code};if(result.code === "MISSING_CREDENTIAL")state.paused_auth=true;}
      else {
        // Success restores the normal cadence: any pending failure retry is
        // cleared together with the backoff.
        delete state.next_attempt_ms;
      }
      await persistState(result.state || state);
      return result;
    } catch (error) {
      const state = await readState();
      const nowMs = Date.now();
      state.last_failure = {
        at: new Date(nowMs).toISOString(),
        code: error.code || "WEBDAV_ERROR",
        ...(Number.isInteger(error.status) ? { status: error.status } : {}),
        ...(Number(error.timeout_ms) > 0 ? { timeout_ms: Number(error.timeout_ms) } : {}),
        ...(['GET','PUT','PROPFIND','MKCOL','MOVE','OPTIONS','DELETE'].includes(error.operation) ? { operation: error.operation } : {}),
      };
      if ((error.code === "WEBDAV_UNAUTHORIZED" || [401,403].includes(error.status))) {
        // Auth failures pause automatic retries; manual sync still allowed.
        state.paused_auth = true;
        delete state.next_attempt_ms;
      } else {
        state.paused_auth = false;
        state.backoff_step = Math.min((state.backoff_step || 0) + 1, BACKOFF_STEPS_MS.length);
        const waitMs = error.retryAfterMs != null && error.retryAfterMs > 0
          ? error.retryAfterMs
          : BACKOFF_STEPS_MS[state.backoff_step - 1];
        state.backoff_until_ms = nowMs + waitMs;
        // The retry fires near the backoff expiry, independent of the
        // configured sync interval.
        state.next_attempt_ms = state.backoff_until_ms;
      }
      await persistState(state);
      return { ok: false, code: error.code || "WEBDAV_ERROR", error };
    } finally {
      await cycleLock?.release(); cycleLock = null;
      running = false;
    }
  }

  function intervalMs(config) {
    return (normalizeConfig(config)?.intervalMinutes || DEFAULT_INTERVAL_MINUTES) * 60_000;
  }

  function start() {
    stop();
    let stopped = false;
    const startedEpoch=epoch;
    const tick = async () => {
      if (stopped || epoch!==startedEpoch) return;
      const config = await getConfig().catch(() => null);
      const state = await readState();
      const nowMs = Date.now();
      if (state.paused_auth) return schedule(config);
      // A pending failure retry wakes the loop at the backoff expiry, not at
      // the next full interval; otherwise keep the configured cadence.
      const pendingRetryMs = Number(state.next_attempt_ms || 0);
      if (pendingRetryMs > nowMs) {
        timer = setTimeout(tick, Math.max(250, pendingRetryMs - nowMs));
        timer.unref?.();
        return;
      }
      await cycle();
      schedule(config);
    };
    const schedule = (config) => {
      if (stopped || epoch!==startedEpoch) return;
      timer = setTimeout(tick, intervalMs(config));
      timer.unref?.();
    };
    try {
      watcher=require('node:fs').watch(trackerDir,(_event,file)=>{
        if(!['queue.jsonl','project.queue.jsonl','fork-prefs.json'].includes(String(file)))return;
        clearTimeout(debounce);debounce=setTimeout(()=>{if(epoch===startedEpoch)void cycle();},30_000);debounce.unref?.();
      });
      watcher.on('error',()=>{});watcher.unref?.();
    }catch { /* minute polling remains available if watch is unsupported */ }
    // First cycle soon after start (lets serve pick up early changes), then
    // on the configured cadence.
    timer = setTimeout(tick, 5_000);
    timer.unref?.();
    return () => {
      stopped = true;
      stop();
    };
  }

  function stop() {
    epoch++;watcher?.close();watcher=null;clearTimeout(debounce);debounce=null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function resetRetry() {
    const state=await readState();state.paused_auth=false;state.backoff_until_ms=0;state.backoff_step=0;state.last_failure=null;delete state.next_attempt_ms;await persistState(state);
    // A shorter interval must not wait for the old (possibly 24h) timer.
    if (timer) start();
  }

  async function syncNow() {
    return cycle({ manual: true });
  }

  const instance = { start, stop, syncNow, cycle, readState, resetRetry };
  instances.set(trackerDir,instance);
  return instance;
}

module.exports = {
  createWebdavScheduler,
  runSyncCycle,
  normalizeConfig,
  webdavDirFor,
  DEFAULT_INTERVAL_MINUTES,
};
