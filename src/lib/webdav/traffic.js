"use strict";

// Cumulative WebDAV payload traffic per calendar month (local time), kept in
// webdav/traffic.json next to the other WebDAV state. 坚果云 free accounts cap
// monthly upload/download separately, so the sync page shows how much of that
// budget the fork has spent this month. The in-memory accumulator is fed by
// the shared WebDavClient and flushed (atomically, once per sync cycle) by the
// scheduler; a month rollover resets the counters on the next flush or read.
// History is intentionally not kept — this is a budget recall aid, not billing.

const fs = require("node:fs/promises");
const path = require("node:path");
const { writeFileAtomic } = require("../fs");

const pending = { uploaded: 0, downloaded: 0 };

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function record({ uploaded = 0, downloaded = 0 } = {}) {
  pending.uploaded += Math.max(0, Number(uploaded) || 0);
  pending.downloaded += Math.max(0, Number(downloaded) || 0);
}

function snapshot() {
  return { uploaded: pending.uploaded, downloaded: pending.downloaded };
}

async function flush(trackerDir) {
  const file = path.join(webdavDirFor(trackerDir), "traffic.json");
  const current = await read(trackerDir);
  current.uploaded += pending.uploaded;
  current.downloaded += pending.downloaded;
  pending.uploaded = 0;
  pending.downloaded = 0;
  current.updatedAt = new Date().toISOString();
  await writeFileAtomic(file, JSON.stringify(current));
  return current;
}

async function read(trackerDir) {
  const base = { month: monthKey(), uploaded: 0, downloaded: 0, updatedAt: null };
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(webdavDirFor(trackerDir), "traffic.json"), "utf8"));
    if (!parsed || parsed.month !== monthKey()) return base;
    return {
      month: parsed.month,
      uploaded: Math.max(0, Number(parsed.uploaded) || 0),
      downloaded: Math.max(0, Number(parsed.downloaded) || 0),
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return base;
  }
}

function webdavDirFor(trackerDir) {
  return path.join(trackerDir, "webdav");
}

module.exports = { record, snapshot, flush, read };
