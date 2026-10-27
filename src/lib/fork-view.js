const fs = require("node:fs/promises");
const path = require("node:path");
const durable = require("./fork-store");
const exporter = require("./sync-store/exporter");
const privacy = require("./sync-store/privacy");
const {
  createDeviceImportStore,
  mergeBucketsAcrossDevices,
} = require("./sync-store/importer");
const prefs = require("./fork-prefs");
const { getOrCreateMachineId } = require("./machine-id");
async function remote(trackerDir) {
  const importsDir = path.join(trackerDir, "webdav", "imports");
  let entries = [];
  try {
    entries = await fs.readdir(importsDir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const devices = [];
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const store = createDeviceImportStore({
      importsDir,
      machineId: entry.name,
    });
    devices.push({
      machineId: entry.name,
      store,
      info: await store.readDeviceInfo(),
    });
  }
  // Preserve the existing offline import channel alongside WebDAV. Prefer
  // WebDAV when the same device is present in both channels.
  const transfer = require("./local-usage-transfer").createLocalUsageTransfer({
    queuePath: path.join(trackerDir, "queue.jsonl"),
    normalizeRow: (r) => r,
    identity: () => ({
      id: getOrCreateMachineId(path.join(trackerDir, "queue.jsonl")),
    }),
  });
  for (const snapshot of await transfer.readImportedDevices())
    if (!devices.some((d) => d.machineId === snapshot.machine.id)) {
      const machineId = snapshot.machine.id;
      devices.push({
        machineId,
        info: {
          id: machineId,
          name: snapshot.machine.name,
          platform: snapshot.machine.platform,
        },
        store: {
          readMergedBuckets: async () =>
            snapshot.rows.map((r) => ({ ...r, device: machineId })),
          readMergedProjects: async () => [],
          readMergedSessions: async () => [],
          readMergedPrefs: async () => [],
          highWater: async () => ({ buckets: snapshot.sequence }),
          sourceHashes: async () => ({}),
        },
      });
    }
  return devices;
}
async function preferences(trackerDir) {
  const devices = await remote(trackerDir);
  const events = [
    ...(await prefs.local(trackerDir)),
    ...(
      await Promise.all(devices.map((d) => d.store.readMergedPrefs()))
    ).flat(),
  ];
  return prefs.resolve(events);
}
async function ownSnapshot(trackerDir, kind, current, keyOf) {
  const wire = await durable.read(
    path.join(trackerDir, "fork-history", `wire-${kind}.json`),
    [],
  );
  const state = await durable.read(
    path.join(trackerDir, "webdav", "state.json"),
    {},
  );
  const unchanged =
    state.input_hashes?.[kind] === exporter.stableRowsHash(current);
  return [
    ...new Map(
      (unchanged ? [...current, ...wire] : [...wire, ...current]).map((r) => [
        keyOf(r),
        r,
      ]),
    ).values(),
  ];
}
async function scope(trackerDir, url) {
  const saved = await durable.read(path.join(trackerDir, "fork-view.json"), {
    device: "all",
  });
  return url?.searchParams.get("device") || saved.device || "all";
}
async function buckets(trackerDir, url) {
  const device = await scope(trackerDir, url);
  const machineId = getOrCreateMachineId(path.join(trackerDir, "queue.jsonl"));
  const rawRows = await require("./fork-costs").capture(
    trackerDir,
    exporter.buildBucketsRows({
      queuePath: path.join(trackerDir, "queue.jsonl"),
      machineId,
    }),
  );
  const localRows = await ownSnapshot(
    trackerDir,
    "buckets",
    rawRows,
    exporter.bucketRowKey,
  );
  if (device === "local" || device === machineId)
    return mergeBucketsAcrossDevices({ localRows, remoteDevices: [] });
  const devices = await remote(trackerDir);
  if (device !== "all" && !devices.some((d) => d.machineId === device))
    throw new Error("selected device unavailable");
  const selected = devices.filter(
    (d) => device === "all" || d.machineId === device,
  );
  return mergeBucketsAcrossDevices({
    localRows: device === "all" ? localRows : [],
    remoteDevices: await Promise.all(
      selected.map(async (d) => ({
        machineId: d.machineId,
        rows: await d.store.readMergedBuckets(),
      })),
    ),
  });
}
async function projects(trackerDir, url) {
  const device = await scope(trackerDir, url);
  const machineId = getOrCreateMachineId(path.join(trackerDir, "queue.jsonl"));
  const all = [];
  if (["all", "local", machineId].includes(device))
    all.push(
      ...(await ownSnapshot(
        trackerDir,
        "projects",
        exporter.buildProjectsRows({
          projectQueuePath: path.join(trackerDir, "project.queue.jsonl"),
          machineId,
        }),
        exporter.projectRowKey,
      )),
    );
  for (const d of await remote(trackerDir))
    if (device === "all" || device === d.machineId)
      all.push(...(await d.store.readMergedProjects()));
  const pref = await preferences(trackerDir);
  return all.map((r) => ({
    ...r,
    original_project_key: r.project_key,
    project_key: prefs.alias(r.project_key, pref.aliases),
  }));
}
async function collectSessions(
  trackerDir,
  { home, force = false, scan = true } = {},
) {
  if (!scan)
    return durable.read(
      path.join(trackerDir, "fork-history", "sessions.json"),
      [],
    );
  const {
    buildSessionAnalytics,
    mergeSessionFragments,
  } = require("./session-analytics");
  const observed = await buildSessionAnalytics({ home, force });
  const sessions = mergeSessionFragments([
    ...observed,
    ...(await require("./fork-dsh-sessions").scanDshSessions(home)),
  ]);
  // Store upstream fragments as a group, keyed by stable source/session hash.
  // Session browser performs the existing fragment merge once on read.
  const groups = new Map();
  const projectCache = new Map();
  for (const row of sessions) {
    if (!row.session_hash) continue;
    if (
      row.project_ref &&
      (path.isAbsolute(row.project_ref) ||
        path.win32.isAbsolute(row.project_ref))
    ) {
      const meta = await require("./rollout").resolveProjectMetaForPath(
        row.project_ref,
        projectCache,
      );
      row.fork_project_key = privacy.projectIdentity(
        { ...row, project_ref: meta?.projectRef || row.project_ref },
        require("./machine-id").getOrCreateMachineId(
          path.join(trackerDir, "queue.jsonl"),
        ),
      );
    }
    const list = groups.get(row.session_hash) || [];
    list.push(row);
    groups.set(row.session_hash, list);
  }
  const file = path.join(trackerDir, "fork-history", "session-groups.json");
  const retained = await durable.serial(file, async () => {
    const prior = await durable.read(file, {});
    const before = JSON.stringify(prior);
    for (const [key, rows] of groups) {
      // Incomplete reads cannot revise a durable record downward.
      if (
        (observed.skippedFiles || observed.incompleteDirs?.length) &&
        prior[key]
      )
        continue;
      const row = rows[0];
      // Ignore pricing-only changes when deciding whether usage was revised.
      const signature = JSON.stringify({
        tokens: row.tokens,
        total: row.total_tokens,
        model: row.model,
        start: row.started_at,
        end: row.ended_at,
        models: row.model_usage?.map((m) =>
          Object.fromEntries(
            Object.entries(m).filter(
              ([k]) => k === "model" || k.endsWith("_tokens"),
            ),
          ),
        ),
      });
      const old = prior[key]?.[0];
      row.fork_usage_revision = signature;
      row.fork_frozen_cost_usd =
        old?.fork_usage_revision === signature
          ? (old.fork_frozen_cost_usd ?? old.cost_usd)
          : row.cost_usd;
      row.cost_usd = row.fork_frozen_cost_usd;
      prior[key] = [row];
    }
    const retained = Object.values(prior).flat();
    const snapshot = path.join(trackerDir, "fork-history", "sessions.json");
    let missing = false;
    try {
      await fs.access(snapshot);
    } catch (e) {
      if (e.code === "ENOENT") missing = true;
      else throw e;
    }
    if (before !== JSON.stringify(prior) || missing) {
      await durable.write(file, prior);
      await durable.write(snapshot, retained);
    }
    return retained;
  });
  return retained;
}
async function sessions(trackerDir, url, { home, scan = true } = {}) {
  const machineId = getOrCreateMachineId(path.join(trackerDir, "queue.jsonl"));
  const device = await scope(trackerDir, url);
  const all = [];
  const localConfig = await durable.read(
    path.join(trackerDir, "webdav", "config.json"),
    {},
  );
  const local = await collectSessions(trackerDir, {
    home,
    scan,
    force: url?.searchParams.get("refresh") === "1",
  });
  if (["all", "local", machineId].includes(device)) {
    const safeLocal = local.map((r) =>
      privacy.session(r, machineId, {
        syncTitles: localConfig.sync_titles !== false,
      }),
    );
    const resolved = await ownSnapshot(
      trackerDir,
      "sessions",
      safeLocal,
      (r) => r.session_hash,
    );
    const originalBySnapshot = new Map(
      safeLocal.map((row, i) => [exporter.stableRowsHash([row]), local[i]]),
    );
    all.push(
      ...resolved.map((r) => {
        // Equal totals do not prove that an old local backup has the recovered
        // model, token categories or price basis. Keep local-only metadata only
        // when its entire sanitized snapshot matches the selected record.
        const original = originalBySnapshot.get(exporter.stableRowsHash([r]));
        return {
          ...(original || r),
          restored: !original,
          device: machineId,
          device_name: localConfig.device_name || require("node:os").hostname(),
          project_key: r.project_key,
        };
      }),
    );
  }
  for (const d of await remote(trackerDir))
    if (device === "all" || device === d.machineId)
      all.push(
        ...(await d.store.readMergedSessions()).map((r) => ({
          ...r,
          device: d.machineId,
          device_name: d.info?.name || d.machineId,
          remote: true,
          project_ref: null,
        })),
      );
  const pref = await preferences(trackerDir);
  return all.map((r) => ({
    ...r,
    project_key: prefs.alias(r.project_key, pref.aliases),
  }));
}
async function devices(trackerDir) {
  const machineId = getOrCreateMachineId(path.join(trackerDir, "queue.jsonl"));
  return [
    { id: machineId, name: "本机", local: true },
    ...(await remote(trackerDir)).map((d) => ({
      id: d.machineId,
      ...d.info,
      local: false,
    })),
  ];
}
module.exports = {
  remote,
  preferences,
  scope,
  buckets,
  projects,
  collectSessions,
  sessions,
  devices,
};
