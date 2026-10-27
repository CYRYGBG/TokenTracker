// Portable statistics backup, separate from WebDAV credentials and raw logs.
// Restoration fills missing records; it never rolls current records backward.
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const durable = require("./fork-store");
const exporter = require("./sync-store/exporter");
const privacy = require("./sync-store/privacy");
const prefs = require("./fork-prefs");
const { serializeDocument, parseDocument } = require("./sync-store/format");
const { createDeviceImportStore } = require("./sync-store/importer");
const METHODS = {
  buckets: "readMergedBuckets",
  projects: "readMergedProjects",
  sessions: "readMergedSessions",
  prefs: "readMergedPrefs",
};
const keyOf = {
  buckets: exporter.bucketRowKey,
  projects: exporter.projectRowKey,
  sessions: (r) => r.session_hash,
  prefs: (r) => r.id,
};
const checksum = (devices) =>
  crypto.createHash("sha256").update(JSON.stringify(devices)).digest("hex");
async function exportBackup(trackerDir, { home } = {}) {
  const view = require("./fork-view");
  const machineId = require("./machine-id").getOrCreateMachineId(
    path.join(trackerDir, "queue.jsonl"),
  );
  const state = await durable.read(
    path.join(trackerDir, "webdav", "state.json"),
    {},
  );
  const sessions = await view.collectSessions(trackerDir, { home });
  const local = {
    buckets: exporter.buildBucketsRows({
      queuePath: path.join(trackerDir, "queue.jsonl"),
      machineId,
    }),
    projects: exporter.buildProjectsRows({
      projectQueuePath: path.join(trackerDir, "project.queue.jsonl"),
      machineId,
    }),
    sessions: sessions.map((r) => privacy.session(r, machineId)),
    prefs: await prefs.local(trackerDir),
  };
  const devices = [
    {
      id: machineId,
      documents: Object.fromEntries(
        Object.keys(METHODS).map((kind) => [
          kind,
          serializeDocument({
            kind,
            device: machineId,
            seq: Math.max(1, state.docs?.[kind]?.seq || 1),
            rows: local[kind],
          }),
        ]),
      ),
    },
  ];
  for (const remote of await view.remote(trackerDir)) {
    const highWater = await remote.store.highWater();
    const documents = {};
    for (const [kind, method] of Object.entries(METHODS))
      documents[kind] = serializeDocument({
        kind,
        device: remote.machineId,
        seq: Math.max(1, highWater[kind]),
        rows: await remote.store[method](),
      });
    devices.push({
      id: remote.machineId,
      documents,
      source_hashes: await remote.store.sourceHashes(),
    });
  }
  return {
    format: "tokentracker-personal-backup",
    version: 1,
    created_at: new Date().toISOString(),
    devices,
    sha256: checksum(devices),
  };
}
function validateBackup(backup) {
  if (
    backup?.format !== "tokentracker-personal-backup" ||
    backup.version !== 1 ||
    !Array.isArray(backup.devices) ||
    backup.devices.length > 128 ||
    backup.sha256 !== checksum(backup.devices)
  )
    throw new Error("invalid backup or checksum");
  const documents = [];
  const seen = new Set();
  for (const device of backup.devices) {
    if (!/^[\w-]{1,128}$/.test(device.id) || seen.has(device.id))
      throw new Error("invalid backup device");
    seen.add(device.id);
    for (const [kind, text] of Object.entries(device.documents || {})) {
      if (!METHODS[kind]) throw new Error("unsupported backup kind");
      const doc = parseDocument(text);
      if (
        doc.header.device !== device.id ||
        doc.header.kind !== kind ||
        doc.header.since_seq !== null
      )
        throw new Error("backup identity mismatch");
      doc.rows = doc.rows.map((row) =>
        require("./sync-store/importer").sanitizeImportRow(
          kind,
          row,
          device.id,
        ),
      );
      doc.header.recovery_hash = /^[a-f0-9]{64}$/.test(
        device.source_hashes?.[kind] || "",
      )
        ? device.source_hashes[kind]
        : null;
      documents.push(doc);
    }
  }
  return documents;
}
async function restoreBackup(trackerDir, backup) {
  const documents = validateBackup(backup);
  const machineId = require("./machine-id").getOrCreateMachineId(
    path.join(trackerDir, "queue.jsonl"),
  );
  let added = 0;
  for (const doc of documents) {
    const { kind, device } = doc.header;
    if (device !== machineId) {
      const store = createDeviceImportStore({
        importsDir: path.join(trackerDir, "webdav", "imports"),
        machineId: device,
      });
      added += await store.restoreMissing(doc);
      continue;
    }
    if (kind === "buckets" || kind === "projects") {
      const file = path.join(
        trackerDir,
        kind === "buckets" ? "queue.jsonl" : "project.queue.jsonl",
      );
      const current =
        kind === "buckets"
          ? exporter.buildBucketsRows({ queuePath: file, machineId })
          : exporter.buildProjectsRows({ projectQueuePath: file, machineId });
      const known = new Set(current.map(keyOf[kind]));
      const missing = doc.rows.filter((r) => !known.has(keyOf[kind](r)));
      if (missing.length) {
        await fs.mkdir(trackerDir, { recursive: true });
        await fs.appendFile(
          file,
          missing.map(JSON.stringify).join("\n") + "\n",
          { mode: 0o600 },
        );
        added += missing.length;
      }
    } else if (kind === "sessions") {
      const file = path.join(trackerDir, "fork-history", "session-groups.json");
      await durable.serial(file, async () => {
        const current = await durable.read(file, {});
        for (const row of doc.rows)
          if (!current[row.session_hash]) {
            current[row.session_hash] = [{ ...row, restored: true }];
            added++;
          }
        await durable.write(file, current);
        await durable.write(
          path.join(trackerDir, "fork-history", "sessions.json"),
          Object.values(current).flat(),
        );
      });
    } else {
      const file = path.join(trackerDir, "fork-prefs.json");
      await durable.serial(file, async () => {
        const current = await prefs.local(trackerDir);
        const known = new Set(current.map((r) => r.id));
        const missing = doc.rows.filter((r) => !known.has(r.id));
        await durable.write(file, [...current, ...missing]);
        added += missing.length;
      });
    }
  }
  require("./fork-costs").invalidate(trackerDir);
  return { ok: true, added, policy: "missing-records-only" };
}
module.exports = { exportBackup, restoreBackup, validateBackup };
