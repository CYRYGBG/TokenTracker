// Import side of the fork sync: applies remote devices' documents into a
// per-device merged view under webdav/imports/<machineId>/ and builds the
// cross-device "all devices" view with the merge rules from SYNC_DESIGN §3:
//   - per-device sources: SUM across devices (independent real consumption)
//   - account-level sources (cursor): whole-row MAX per (source, hour, model)
//     across devices — src/lib/account-usage-dedup.js semantics
//   - trae-cn: session-state LWW then aggregate
// Missing keys are never deletions; a later sequence replaces the same key
// (including legitimate downward corrections) for the SAME device only.

const fs = require("node:fs/promises");
const path = require("node:path");

const {
  upsertAccountSessionStates,
  aggregateSessionStates,
  dedupeAccountLevelRows,
} = require("../account-usage-dedup");
const { isAccountLevelSource } = require("../source-metadata");
const { serializeDocument, parseDocument } = require("./format");

const TOKEN_SUM_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_output_tokens",
  "total_tokens",
  "billable_total_tokens",
  "total_cost_usd",
  "conversation_count",
  "fork_estimated_cost_usd",
];

function importDirFor(rootImportsDir, machineId) {
  return path.join(rootImportsDir, machineId);
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tmp, filePath);
}

function rowSortKey(row) {
  return `${row.source}|${row.model}|${row.hour_start}`;
}

// ---------------------------------------------------------------------------
// Per-device import store: keeps the device's CURRENT merged view (one row per
// key) plus the applied-sequence journal. Rows are whole-record upserts; the
// journal records which base/segments were applied so replays are no-ops.
// ---------------------------------------------------------------------------

const KINDS = ["buckets", "projects", "sessions", "prefs"];
function rowKey(kind, row) {
  if (kind === "projects")
    return `${row.project_key}|${row.source}|${row.hour_start}`;
  if (kind === "sessions") return row.session_hash;
  if (kind === "prefs") return row.id;
  if (row?.kind === "account_session_state")
    return `state|${row.source}|${row.session_id}`;
  return `${row.source}|${row.model}|${row.hour_start}`;
}
function sanitizeImportRow(kind, row, machineId) {
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    (row.device && row.device !== machineId)
  )
    throw new Error("invalid row identity");
  const privacy = require("./privacy");
  if (kind === "prefs") {
    require("../fork-prefs").validateEvent(row);
    if (row.device !== machineId) throw new Error("event device mismatch");
    return require("../fork-prefs").sanitize(row);
  }
  if (typeof row.source !== "string" || !privacy.safeText(row.source, 120))
    throw new Error("invalid row source");
  if (kind === "sessions") {
    if (
      typeof row.session_hash !== "string" ||
      !/^[\w-]{1,128}$/.test(row.session_hash)
    )
      throw new Error("invalid session identity");
  } else if (
    row.kind !== "account_session_state" &&
    !Number.isFinite(Date.parse(row.hour_start || ""))
  )
    throw new Error("invalid bucket time");
  if (
    kind === "projects" &&
    (typeof row.project_key !== "string" || !row.project_key)
  )
    throw new Error("invalid project identity");
  for (const k of TOKEN_SUM_COLUMNS)
    if (
      row[k] != null &&
      (typeof row[k] !== "number" || !Number.isFinite(row[k]) || row[k] < 0)
    )
      throw new Error("invalid usage count");
  return privacy[
    kind === "buckets" ? "bucket" : kind === "projects" ? "project" : "session"
  ](row, machineId);
}
function createDeviceImportStore({ importsDir, machineId }) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(machineId))
    throw new Error("invalid device id");
  const dir = importDirFor(importsDir, machineId);
  const durable = require("../fork-store");
  // Production import dirs (<tracker>/webdav/imports|recovery) are handled by
  // the incremental journal; arbitrary directories (unit-test fixtures) fall
  // back to whole-file atomic writes with identical semantics.
  const commit = (file, value) =>
    durable.handles(file)
      ? durable.writeUnlocked(file, value)
      : durable.write(file, value);
  async function load(kind) {
    if (!KINDS.includes(kind)) throw new Error("unsupported document kind");
    const current = await durable.read(path.join(dir, `${kind}.json`), null);
    if (current) return current;
    // Migrate the previous JSONL view without dropping collected history.
    let rows = [];
    try {
      rows = (await fs.readFile(path.join(dir, `${kind}.jsonl`), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const journal = await durable.read(path.join(dir, "applied.json"), {});
    return {
      seq: Number(journal[`${kind}_high_water`] || 0),
      hash: null,
      rows,
    };
  }
  async function applyDocument({ header, rows }) {
    if (
      header.device !== machineId ||
      !KINDS.includes(header.kind) ||
      !Number.isSafeInteger(header.seq) ||
      header.seq < 1
    )
      throw new Error("document identity mismatch");
    const kind = header.kind;
    const file = path.join(dir, `${kind}.json`);
    return durable.serial(file, () =>
      // The read-merge-commit runs inside one cross-process lock so a second
      // serve process cannot commit an envelope built from a stale snapshot.
      durable.withTransaction([file], async () => {
        const current = await load(kind);
        if (
          header.seq === current.seq &&
          current.hash &&
          header.sha256 !== current.hash
        )
          throw Object.assign(new Error("snapshot conflict"), {
            code: "SNAPSHOT_CONFLICT",
          });
        if (header.seq <= current.seq)
          return {
            applied: false,
            reason: "at-or-below-high-water",
            seq: header.seq,
          };
        if (header.since_seq != null && header.since_seq > current.seq)
          throw Object.assign(new Error("missing predecessor"), {
            code: "MISSING_PREDECESSOR",
          });
        const map = new Map(current.rows.map((row) => [rowKey(kind, row), row]));
        for (const row of rows) {
          if (!row || typeof row !== "object" || !rowKey(kind, row))
            throw new Error("invalid row");
          const clean = sanitizeImportRow(kind, row, machineId);
          map.set(rowKey(kind, clean), clean);
        }
        // Rows + high water commit in ONE atomic step. A crash cannot commit
        // only the cursor and strand a partially written view.
        await commit(file, {
          seq: header.seq,
          hash: header.sha256,
          rows: [...map.values()],
        });
        return { applied: true, upserts: rows.length, seq: header.seq };
      }),
    );
  }
  async function restoreMissing({ header, rows }) {
    if (header.device !== machineId || !KINDS.includes(header.kind))
      throw new Error("backup identity mismatch");
    const file = path.join(dir, `${header.kind}.json`);
    return durable.serial(file, () =>
      durable.withTransaction([file], async () => {
        const current = await load(header.kind);
        const map = new Map(current.rows.map((r) => [rowKey(header.kind, r), r]));
        let added = 0;
        for (const row of rows)
          if (!map.has(rowKey(header.kind, row))) {
            map.set(rowKey(header.kind, row), row);
            added++;
          }
        if (added)
          await commit(file, {
            seq: Math.max(current.seq, header.seq),
            hash:
              header.seq > current.seq
                ? header.recovery_hash || null
                : current.hash,
            rows: [...map.values()],
          });
        return added;
      }),
    );
  }
  async function highWater() {
    const pairs = await Promise.all(
      KINDS.map(async (k) => [k, (await load(k)).seq]),
    );
    return Object.fromEntries(pairs);
  }
  return {
    dir,
    applyDocument,
    highWater,
    restoreMissing,
    sourceHashes: async () =>
      Object.fromEntries(
        await Promise.all(
          KINDS.map(async (kind) => [kind, (await load(kind)).hash]),
        ),
      ),
    saveDeviceInfo: (info) =>
      durable.write(path.join(dir, "device.json"), {
        id: machineId,
        name: require("./privacy").safeText(info?.name, 120) || machineId,
        platform: require("./privacy").safeText(info?.platform),
        updated_at: require("./privacy").safeText(info?.updated_at),
      }),
    readDeviceInfo: () => durable.read(path.join(dir, "device.json"), null),
    readMergedBuckets: async () => (await load("buckets")).rows,
    readMergedProjects: async () => (await load("projects")).rows,
    readMergedSessions: async () => (await load("sessions")).rows,
    readMergedPrefs: async () => (await load("prefs")).rows,
  };
}

// ---------------------------------------------------------------------------
// Cross-device merge (the "all devices" view).
// ---------------------------------------------------------------------------

// Merges this device's local bucket rows with every remote device's merged
// rows. `localRows` come from the exporter (queue.jsonl dedup view, tagged
// with the local machineId); `remoteDevices` is [{ machineId, rows }].
function mergeBucketsAcrossDevices({ localRows, remoteDevices }) {
  const allRows = [
    ...localRows,
    ...remoteDevices.flatMap((device) => device.rows),
  ];
  const sessionStates = [];
  const perDeviceRows = [];
  for (const row of allRows) {
    if (row?.kind === "account_session_state") sessionStates.push(row);
    else perDeviceRows.push(row);
  }

  // 1. Account-level session states (trae-cn): LWW per (user, source,
  //    session), then aggregate into bucket rows.
  const stateTable = new Map();
  for (const observation of sessionStates) {
    upsertAccountSessionStates(stateTable, [observation]);
  }
  const aggregatedStates = aggregateSessionStates(stateTable);

  // 2. Account-level hourly rows (cursor): whole-row MAX per
  //    (source, hour_start, model) across devices.
  const accountRows = perDeviceRows.filter((row) =>
    isAccountLevelSource(row.source),
  );
  const dedupedAccount = dedupeAccountLevelRows(accountRows);

  // 3. Per-device rows: SUM across devices per (source, model, hour_start).
  const perDevice = perDeviceRows.filter(
    (row) => !isAccountLevelSource(row.source),
  );
  const summed = sumRowsByKey(perDevice);

  // Merge deduped account rows and aggregated states into the summed map
  // without double counting: they occupy account-level keys only.
  const merged = new Map(summed);
  for (const row of dedupedAccount) {
    merged.set(`${row.source}|${row.model}|${row.hour_start}`, row);
  }
  for (const row of aggregatedStates) {
    merged.set(`${row.source}|${row.model}|${row.hour_start}`, row);
  }
  return Array.from(merged.values());
}

function sumRowsByKey(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = `${row.source}|${row.model}|${row.hour_start}`;
    const prior = merged.get(key);
    if (!prior) {
      merged.set(key, { ...row });
      continue;
    }
    const next = { ...prior };
    for (const column of TOKEN_SUM_COLUMNS) {
      if (
        column === "fork_estimated_cost_usd" &&
        (!Number.isFinite(prior[column]) || !Number.isFinite(row[column]))
      ) {
        delete next[column];
        continue;
      }
      next[column] = Number(prior[column] || 0) + Number(row[column] || 0);
    }
    next.devices = uniqueDevices(prior, row);
    merged.set(key, next);
  }
  return merged;
}

function uniqueDevices(a, b) {
  const devices = new Set([...(a.devices || []), ...(b.devices || [])]);
  if (a.device) devices.add(a.device);
  if (b.device) devices.add(b.device);
  return Array.from(devices).sort();
}

module.exports = {
  createDeviceImportStore,
  sanitizeImportRow,
  mergeBucketsAcrossDevices,
  importDirFor,
  TOKEN_SUM_COLUMNS,
};
