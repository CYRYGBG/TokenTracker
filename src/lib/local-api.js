const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { setImmediate: yieldToRequests } = require("node:timers/promises");
const { createAsyncQueueReader } = require("./async-queue-reader");
// This fork removed the InsForge cloud (login / sync / leaderboard / billing)
// from the runtime path: local-api only serves local statistics endpoints.
const { resolveRuntimeConfig } = require("./runtime-config");
const {
  filterRowsByUsageScope,
  getSourceScope,
  listExcludedSources,
  normalizeUsageScope,
} = require("./source-metadata");
const { getOrCreateMachineId, computeStableMachineId } = require("./machine-id");
const { createLocalUsageTransfer, MAX_BYTES: LOCAL_USAGE_MAX_BYTES } = require("./local-usage-transfer");

const SYNC_TIMEOUT_MS = 120_000;
const TRACKER_BIN = path.resolve(__dirname, "../../bin/tracker.js");
const MAX_DEVICE_NAME_LENGTH = 128;

function getSystemDeviceName() {
  try {
    const hostname = os.hostname()
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, MAX_DEVICE_NAME_LENGTH);
    return hostname || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-model pricing — delegated to src/lib/pricing/
//   - CURATED overrides (kiro-*, hy3-*, composer-*, kimi-for-coding, etc.)
//   - LiteLLM live data (mainstream claude / gpt-5 / gemini), 24h disk-cached
//   - Bundled seed snapshot for first-install / offline fallback
// ---------------------------------------------------------------------------

const {
  MODEL_PRICING,
  getModelPricing,
  computeRowCost,
  ensurePricingLoaded,
  getPricingRevision,
  getModelPricingInfo,
} = require("./pricing");

const {
  computeClaudeCategoryBreakdown,
  unsupportedSourcePayload: unsupportedCategoryPayload,
} = require("./claude-categorizer");

const { computeCodexContextBreakdown } = require("./codex-context-breakdown");
const { computeGrokContextBreakdown } = require("./grok-context-breakdown");

const {
  deriveProjectKeyFromRef,
  CLAUDE_MEM_OBSERVER_PROJECT_REF,
} = require("./rollout");

// ---------------------------------------------------------------------------
// Queue data helpers
// ---------------------------------------------------------------------------

function resolveQueuePath() {
  const home = os.homedir();
  return path.join(home, (process.env.TOKENTRACKER_PERSONAL === "1" ? ".tokentracker-personal" : ".tokentracker"), "tracker", "queue.jsonl");
}

// Pseudo-project written by the pre-fix claude-mem observer attribution;
// mirrored Claude Code sessions, not a real repository. Excluded at read
// time so historical rows never surface on the Project Usage panel. Derived
// from rollout.js's ref so a rename there cannot silently desync the filter.
const CLAUDE_MEM_OBSERVER_PROJECT_KEY = deriveProjectKeyFromRef(
  CLAUDE_MEM_OBSERVER_PROJECT_REF,
);
const PROJECT_USAGE_MAX_ENTRIES = 10;
const MAX_TIME_ZONE_CACHE_ENTRIES = 16;
const AGGREGATION_BATCH_ROWS = 256;

// The native dashboard fans one refresh out across several local endpoints.
// Keep one immutable, deduped view of the current queue so those endpoints do
// not all read and JSON.parse the same append-only file. A file identity +
// nanosecond timestamp signature invalidates the cache immediately on append,
// in-place rewrite, or atomic replacement.
const dailyAggregationCache = new WeakMap();
const zonedPartsFormatters = new Map();

function boundedCacheSet(cache, key, value, maxEntries) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    cache.delete(cache.keys().next().value);
  }
}

function timeZoneContextKey({ timeZone, offsetMinutes } = {}) {
  return `${timeZone || ""}|${Number.isFinite(offsetMinutes) ? offsetMinutes : ""}|p${getPricingRevision()}`;
}

// Shared by project-usage-summary and project-usage-detail: reads the
// deduped project bucket log, drops the claude-mem pseudo project, and
// builds the from/to day-range predicate. Callers compute each row's day
// key ONCE (rowDayKey constructs an Intl.DateTimeFormat per call — the
// dominant per-row cost) and reuse it for both the range check and any
// day bucketing.
async function readProjectUsageContext(qp, url) {
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const timeZoneContext = getTimeZoneContext(url);
  const hasRange = Boolean(from || to);
  const dayInRange = (day) => {
    if (!hasRange) return true;
    if (!day) return false;
    return (!from || day >= from) && (!to || day <= to);
  };
  const projectQueuePath = path.join(path.dirname(qp), "project.queue.jsonl");
  const projectRows = (await require("./fork-view").projects(path.dirname(qp), url)).filter(
    (row) => row.project_key !== CLAUDE_MEM_OBSERVER_PROJECT_KEY,
  );
  return { from, to, timeZoneContext, hasRange, dayInRange, projectRows };
}

// Same signature-based caching as readQueueData: the project-usage endpoints
// all fan out from one dashboard refresh, so without this every request
// re-read and re-parsed the whole append-only project queue.
const readProjectQueueData = createAsyncQueueReader({
  label: "readProjectQueueData",
  parseRow(row) {
    return {
      key: `${row.project_key || ""}|${row.source || ""}|${row.hour_start || ""}`,
      row: normalizeQueueRow(row),
    };
  },
});

function isLegacyInclusiveCodexRow(row) {
  if (!row || (row.source !== "codex" && row.source !== "every-code")) return false;
  const inputTokens = Number(row.input_tokens || 0);
  const cachedInputTokens = Number(row.cached_input_tokens || 0);
  const outputTokens = Number(row.output_tokens || 0);
  const totalTokens = Number(row.total_tokens || 0);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(cachedInputTokens)) return false;
  if (cachedInputTokens <= 0 || inputTokens < cachedInputTokens) return false;
  // Legacy Codex queue rows stored input inclusive of cache reads, while
  // total_tokens remained input + output. Canonical rows keep input as pure
  // non-cached input, so cache-heavy legacy rows can be identified by this
  // exact invariant.
  return totalTokens === inputTokens + outputTokens;
}

function normalizeQueueRow(row) {
  let normalized = row;
  if (isLegacyInclusiveCodexRow(normalized)) {
    normalized = {
      ...normalized,
      input_tokens:
        Number(normalized.input_tokens || 0) - Number(normalized.cached_input_tokens || 0),
    };
  }
  // Legacy Cursor rows from versions ≤ 0.26.5 wrote billable_total_tokens = 0
  // for "Included in Pro" / "Enterprise" / "no charge" records (kind-based
  // gating in cursor-config.js#normalizeCursorUsage). The dashboard headline
  // sums billable_total_tokens across sources, so those rows silently
  // disappeared from the displayed total once any other source contributed
  // non-zero billable usage (GitHub issue #106). Treat billing and usage as
  // orthogonal: bump billable up to total_tokens at read time so historical
  // queue.jsonl entries render correctly without requiring a file rewrite.
  // Antigravity had the same symptom from e69e2746a (billable deleted during
  // the O(N) refactoring, leaving 167 local rows with billable=0 until the
  // parser fix). Apply the same read-time healing so upgraded installs show
  // correct heatmap / rolling numbers without a queue rewrite.
  const sourceName = String(normalized.source || "").toLowerCase();
  if (sourceName === "cursor" || sourceName === "antigravity") {
    const totalTokens = Number(normalized.total_tokens || 0);
    const billable = Number(normalized.billable_total_tokens || 0);
    if (totalTokens > 0 && billable < totalTokens) {
      normalized = { ...normalized, billable_total_tokens: totalTokens };
    }
  }
  return normalized;
}

const readQueueData = createAsyncQueueReader({
  label: "readQueueData",
  parseRow(row) {
    if (row?.kind === "account_session_state" || row?.kind === "account_sync_watermark") return null;
    return {
      key: `${row.source || ""}|${row.model || ""}|${row.hour_start || ""}`,
      row: normalizeQueueRow(row),
    };
  },
});

function rowDayKey(row, timeZoneContext) {
  const hs = row.hour_start;
  if (!hs) return "";
  if (
    timeZoneContext &&
    (timeZoneContext.timeZone || Number.isFinite(timeZoneContext.offsetMinutes))
  ) {
    const parts = getZonedParts(new Date(hs), timeZoneContext);
    const key = formatPartsDayKey(parts);
    if (key) return key;
  }
  return hs.slice(0, 10);
}

function aggregateByDay(rows, timeZoneContext = null) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const cacheKey = timeZoneContextKey(timeZoneContext || {});
  let cachedByTimeZone = dailyAggregationCache.get(normalizedRows);
  if (cachedByTimeZone?.has(cacheKey)) {
    const cached = cachedByTimeZone.get(cacheKey);
    // Touch the entry so the small per-queue map behaves as an LRU.
    cachedByTimeZone.delete(cacheKey);
    cachedByTimeZone.set(cacheKey, cached);
    return cached;
  }

  if (!cachedByTimeZone) {
    cachedByTimeZone = new Map();
    dailyAggregationCache.set(normalizedRows, cachedByTimeZone);
  }
  const pending = buildDailyAggregates(normalizedRows, timeZoneContext).then((daily) => {
    // Pricing can refresh while a large aggregation yields. Rebuild consistently
    // with the current catalog instead of publishing a mix of two revisions.
    if (cacheKey !== timeZoneContextKey(timeZoneContext || {})) {
      cachedByTimeZone.delete(cacheKey);
      return aggregateByDay(normalizedRows, timeZoneContext);
    }
    return daily;
  }).catch((error) => {
    if (cachedByTimeZone.get(cacheKey) === pending) cachedByTimeZone.delete(cacheKey);
    throw error;
  });
  // Share both completed and in-flight aggregates across summary/daily/heatmap.
  boundedCacheSet(cachedByTimeZone, cacheKey, pending, MAX_TIME_ZONE_CACHE_ENTRIES);
  return pending;
}

async function buildDailyAggregates(normalizedRows, timeZoneContext) {
  const byDay = new Map();
  let processed = 0;
  for (const row of normalizedRows) {
    if (++processed % AGGREGATION_BATCH_ROWS === 0) await yieldToRequests();
    if (!row.hour_start) continue;
    const day = rowDayKey(row, timeZoneContext);
    if (!day) continue;
    if (!byDay.has(day)) {
      byDay.set(day, {
        day,
        total_tokens: 0,
        billable_total_tokens: 0,
        total_cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      });
    }
    const a = byDay.get(day);
    a.total_tokens += row.total_tokens || 0;
    a.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
    a.total_cost_usd += computeRowCost(row);
    a.input_tokens += row.input_tokens || 0;
    a.output_tokens += row.output_tokens || 0;
    a.cached_input_tokens += row.cached_input_tokens || 0;
    a.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
    a.reasoning_output_tokens += row.reasoning_output_tokens || 0;
    a.conversation_count += row.conversation_count || 0;

    if (!a.models) {
      a.models = {};
    }
    const model = row.model || "unknown";
    a.models[model] = (a.models[model] || 0) + (row.total_tokens || 0);
  }
  const daily = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
  return daily;
}

function buildCodexCategoryFallbackFromQueue(queueRows, { from, to, timeZoneContext }) {
  const totals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  let conversationCount = 0;

  for (const row of queueRows || []) {
    if ((row?.source || "") !== "codex") continue;
    if (!row.hour_start) continue;
    const day = rowDayKey(row, timeZoneContext);
    if (from && day < from) continue;
    if (to && day > to) continue;
    totals.input_tokens += Number(row.input_tokens || 0);
    totals.cached_input_tokens += Number(row.cached_input_tokens || 0);
    totals.cache_creation_input_tokens += Number(row.cache_creation_input_tokens || 0);
    totals.output_tokens += Number(row.output_tokens || 0);
    totals.reasoning_output_tokens += Number(row.reasoning_output_tokens || 0);
    totals.total_tokens += Number(row.total_tokens || 0);
    conversationCount += Number(row.conversation_count || 0);
  }

  return {
    source: "codex",
    scope: "supported",
    breakdown_status: "queue_fallback",
    totals,
    session_count: 0,
    message_count: conversationCount,
    fallback: "queue_totals",
    message_breakdown: {
      categories: [
        {
          key: "user_input",
          name: "User input",
          totals: {
            input_tokens: totals.input_tokens,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: totals.input_tokens,
          },
        },
        {
          key: "conversation_history",
          name: "Conversation history",
          totals: {
            input_tokens: 0,
            cached_input_tokens: totals.cached_input_tokens,
            cache_creation_input_tokens: totals.cache_creation_input_tokens,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: totals.cached_input_tokens + totals.cache_creation_input_tokens,
          },
        },
        {
          key: "assistant_response",
          name: "Assistant response",
          totals: {
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: Math.max(0, totals.output_tokens - totals.reasoning_output_tokens),
            reasoning_output_tokens: 0,
            total_tokens: Math.max(0, totals.output_tokens - totals.reasoning_output_tokens),
          },
        },
      ].sort((a, b) => Number(b.totals.total_tokens || 0) - Number(a.totals.total_tokens || 0)),
      privacy: {
        includes_content: false,
        note: "Queue fallback includes aggregated token categories only; message text is never returned.",
      },
    },
    tool_calls_breakdown: {
      total_calls: 0,
      tools: [],
      categories: [],
      tools_total: 0,
      privacy: {
        includes_inputs: false,
        note: "Codex rollout sessions were unavailable; totals come from TokenTracker queue rows.",
      },
    },
    exec_command_breakdown: {
      by_type: [],
      by_exit: [],
    },
  };
}

function getRequestedUsageScope(url) {
  if (url.searchParams.get("include_account_level") === "1") return "all";
  return normalizeUsageScope(url.searchParams.get("scope"));
}

// ── Local achievements ───────────────────────────────────────────────────────
// Local-only badges (the cloud nine live in scripts/ops/user-badges.sql).
// Thresholds are ordered bronze → silver → gold → diamond. This module is the
// single server-side home for LOCAL thresholds; the dashboard renders whatever
// the payload says and embeds none of these numbers.
const LOCAL_BADGE_THRESHOLDS = {
  project_hopper: [3, 5, 10, 20], // distinct projects
  project_devotion: [1000000, 10000000, 100000000, 1000000000], // max tokens in one project
  night_owl: [5, 20, 60, 150], // active hour buckets between 00:00–05:59 local
};

const LOCAL_TIER_KEYS = ["bronze", "silver", "gold", "diamond"];

/**
 * Compute the local badge set from deduped queue rows.
 * Rows are replayed in hour_start order so each tier's `achieved` timestamp is
 * the hour at which the running metric first crossed that threshold. Local
 * time (night_owl) follows the caller's tz query params like every other
 * usage endpoint.
 */
function computeLocalAchievements(queueRows, projectRows, { timeZoneContext } = {}) {
  const sortByHour = (rows) =>
    rows
      .filter((row) => row && row.hour_start)
      .slice()
      .sort((a, b) => String(a.hour_start).localeCompare(String(b.hour_start)));

  const trackers = {
    project_hopper: { value: 0, achieved: {}, meta: {} },
    project_devotion: { value: 0, achieved: {}, meta: {} },
    night_owl: { value: 0, achieved: {}, meta: {} },
  };

  const bump = (badgeId, newValue, atIso, meta) => {
    const tracker = trackers[badgeId];
    if (newValue <= tracker.value) return;
    tracker.value = newValue;
    if (meta) tracker.meta = meta;
    const thresholds = LOCAL_BADGE_THRESHOLDS[badgeId];
    for (let i = 0; i < thresholds.length; i += 1) {
      const tierKey = LOCAL_TIER_KEYS[i];
      if (newValue >= thresholds[i] && !tracker.achieved[tierKey]) {
        tracker.achieved[tierKey] = atIso;
      }
    }
  };

  const seenProjects = new Set();
  const perProjectTokens = new Map();
  for (const row of sortByHour(projectRows || [])) {
    const projectKey = row.project_key;
    const tokens = Number(row.total_tokens || 0);
    if (!projectKey || tokens <= 0) continue;
    if (!seenProjects.has(projectKey)) {
      seenProjects.add(projectKey);
      bump("project_hopper", seenProjects.size, row.hour_start);
    }
    const running = (perProjectTokens.get(projectKey) || 0) + tokens;
    perProjectTokens.set(projectKey, running);
    if (running > trackers.project_devotion.value) {
      bump("project_devotion", running, row.hour_start, { project_key: projectKey });
    }
  }

  const nightHours = new Set();
  for (const row of sortByHour(queueRows || [])) {
    if (Number(row.total_tokens || 0) <= 0) continue;
    if (nightHours.has(row.hour_start)) continue;
    const parts = getZonedParts(new Date(row.hour_start), timeZoneContext || {});
    if (!parts || parts.hour >= 6) continue;
    nightHours.add(row.hour_start);
    bump("night_owl", nightHours.size, row.hour_start);
  }

  return Object.entries(LOCAL_BADGE_THRESHOLDS).map(([badgeId, thresholds]) => {
    const tracker = trackers[badgeId];
    let tier = 0;
    for (let i = 0; i < thresholds.length; i += 1) {
      if (tracker.value >= thresholds[i]) tier = i + 1;
    }
    return {
      id: badgeId,
      tier,
      metric_value: tracker.value,
      thresholds: thresholds.slice(),
      lower_is_better: false,
      next_threshold: tier >= 4 ? null : thresholds[tier],
      achieved: {
        bronze: tracker.achieved.bronze || null,
        silver: tracker.achieved.silver || null,
        gold: tracker.achieved.gold || null,
        diamond: tracker.achieved.diamond || null,
      },
      meta: tracker.meta,
    };
  });
}

function getTimeZoneContext(url) {
  const tz = String(url.searchParams.get("tz") || "").trim();
  const rawOffset = Number(url.searchParams.get("tz_offset_minutes"));
  return {
    timeZone: tz || null,
    offsetMinutes: Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : null,
  };
}

function getZonedParts(date, { timeZone, offsetMinutes } = {}) {
  const dt = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(dt.getTime())) return null;

  if (timeZone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
    try {
      let formatter;
      if (zonedPartsFormatters.has(timeZone)) {
        formatter = zonedPartsFormatters.get(timeZone);
      } else {
        try {
          formatter = new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          });
        } catch {
          // Cache invalid zone ids too; otherwise a bad local query would
          // throw once per queue row before falling back to its fixed offset.
          formatter = null;
        }
        boundedCacheSet(
          zonedPartsFormatters,
          timeZone,
          formatter,
          MAX_TIME_ZONE_CACHE_ENTRIES,
        );
      }
      const parts = formatter?.formatToParts(dt) || [];
      const values = parts.reduce((acc, part) => {
        if (part.type && part.value) acc[part.type] = part.value;
        return acc;
      }, {});
      const year = Number(values.year);
      const month = Number(values.month);
      const day = Number(values.day);
      const hour = Number(values.hour);
      const minute = Number(values.minute);
      const second = Number(values.second);
      if ([year, month, day, hour, minute, second].every(Number.isFinite)) {
        return { year, month, day, hour, minute, second };
      }
    } catch (_e) {
      // fall through
    }
  }

  if (Number.isFinite(offsetMinutes)) {
    const shifted = new Date(dt.getTime() + offsetMinutes * 60 * 1000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
    };
  }

  return {
    year: dt.getFullYear(),
    month: dt.getMonth() + 1,
    day: dt.getDate(),
    hour: dt.getHours(),
    minute: dt.getMinutes(),
    second: dt.getSeconds(),
  };
}

function formatPartsDayKey(parts) {
  if (!parts) return "";
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

async function aggregateHourlyByDay(rows, dayKey, timeZoneContext) {
  const byHour = new Map();
  let processed = 0;
  for (const row of rows) {
    if (++processed % AGGREGATION_BATCH_ROWS === 0) await yieldToRequests();
    if (!row.hour_start) continue;
    const parts = getZonedParts(new Date(row.hour_start), timeZoneContext);
    if (!parts) continue;
    if (formatPartsDayKey(parts) !== dayKey) continue;
    const hourKey = `${dayKey}T${String(parts.hour).padStart(2, "0")}:00:00`;
    if (!byHour.has(hourKey)) {
      byHour.set(hourKey, {
        hour: hourKey,
        total_tokens: 0,
        billable_total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      });
    }
    const bucket = byHour.get(hourKey);
    bucket.total_tokens += row.total_tokens || 0;
    bucket.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
    bucket.input_tokens += row.input_tokens || 0;
    bucket.output_tokens += row.output_tokens || 0;
    bucket.cached_input_tokens += row.cached_input_tokens || 0;
    bucket.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
    bucket.reasoning_output_tokens += row.reasoning_output_tokens || 0;
    bucket.conversation_count += row.conversation_count || 0;

    if (!bucket.models) {
      bucket.models = {};
    }
    const model = row.model || "unknown";
    bucket.models[model] = (bucket.models[model] || 0) + (row.total_tokens || 0);
  }
  return Array.from(byHour.values()).sort((a, b) => a.hour.localeCompare(b.hour));
}

// ---------------------------------------------------------------------------
// Sync helper
// ---------------------------------------------------------------------------

function trimOutput(value, max = 4000) {
  const t = String(value || "");
  return t.length <= max ? t : t.slice(t.length - max);
}

function parseCookieHeader(value) {
  const out = new Map();
  if (typeof value !== "string" || !value.trim()) return out;
  for (const part of value.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim();
    const rawValue = part.slice(idx + 1).trim();
    if (key) out.set(key, rawValue);
  }
  return out;
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function hasAllowedLoopbackOrigin(headers = {}) {
  const candidates = [headers.origin, headers.referer];
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;
    try {
      const url = new URL(String(raw));
      if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) return false;
    } catch (_e) {
      return false;
    }
  }
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) return resolve({});
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function readBodyLimited(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        failed = true;
        reject(new Error(`Request body exceeds ${Math.ceil(maxBytes / 1024 / 1024)} MB`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on("error", (error) => { if (!failed) reject(error); });
  });
}

// Spawn one local `tracker sync` scan. Cloud-only flags (device tokens,
// backend env, publish-account/drain upload modes) were removed with the
// InsForge cloud; this only drives the local source scan.
function runSyncCommand(extraEnv = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = opts.trackerDataDir
      ? ["-e", `require(${JSON.stringify(path.resolve(__dirname, "../commands/sync.js"))}).cmdSync(process.argv.slice(1), ${JSON.stringify({ trackerDataDir: opts.trackerDataDir, home: path.dirname(opts.trackerDataDir), ...(opts.syncContext || {}) })}).catch(e => { console.error(e.message); process.exitCode = 1; })`, "--"]
      : [TRACKER_BIN, "sync"];
    if (opts.auto === true) args.push("--auto");
    if (opts.background === true) args.push("--background");
    if (opts.allLocalSources === true) args.push("--all-local-sources");
    if (opts.waitForLock === true) args.push("--wait-for-lock");
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      fn(v);
    };
    let timedOut = false;
    const tid = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SYNC_TIMEOUT_MS);
    child.stdout?.on("data", (c) => {
      stdout += c;
    });
    child.stderr?.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (e) => {
      finish(reject, Object.assign(e, { stdout: trimOutput(stdout), stderr: trimOutput(stderr) }));
    });
    child.on("close", (code) => {
      if (timedOut) { finish(reject, Object.assign(new Error("Sync timed out"), { code: "SYNC_TIMEOUT", stdout: trimOutput(stdout), stderr: trimOutput(stderr) })); return; }
      const r = { code: code ?? 1, stdout: trimOutput(stdout), stderr: trimOutput(stderr) };
      if (code === 0) {
        finish(resolve, r);
        return;
      }
      const error = Object.assign(
        new Error(r.stderr || r.stdout || `exit ${r.code}`),
        r,
      );
      if (/\bSYNC_BUSY\b/.test(`${r.stderr}\n${r.stdout}`)) {
        error.code = "SYNC_BUSY";
      }
      finish(reject, error);
    });
  });
}

// ---------------------------------------------------------------------------
// Project detection helpers
// ---------------------------------------------------------------------------

function parseGitUrl(url) {
  if (!url) return null;
  const ssh = url.match(/git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const http = url.match(/https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (http) return { owner: http[1], repo: http[2] };
  return null;
}

function extractProjectFromCwd(cwd) {
  const home = os.homedir();
  if (!cwd || cwd === home) return null;
  const rel = cwd.replace(home + "/", "");
  const parts = rel.split("/").filter((p) => p && !p.startsWith(".") && p !== "ext-global");
  return parts.length > 0 ? parts[0] : null;
}

function scanCodexProjects(projectMap) {
  const dir = path.join(os.homedir(), ".codex", "sessions");
  try {
    for (const year of fs.readdirSync(dir)) {
      const yp = path.join(dir, year);
      if (!fs.statSync(yp).isDirectory()) continue;
      for (const month of fs.readdirSync(yp)) {
        const mp = path.join(yp, month);
        if (!fs.statSync(mp).isDirectory()) continue;
        for (const day of fs.readdirSync(mp)) {
          const dp = path.join(mp, day);
          if (!fs.statSync(dp).isDirectory()) continue;
          const files = fs.readdirSync(dp).filter((f) => f.endsWith(".jsonl"));
          for (const file of files.slice(0, 200)) {
            try {
              const first = fs.readFileSync(path.join(dp, file), "utf8").split("\n")[0];
              const d = JSON.parse(first);
              if (d.git?.repository_url) {
                const p = parseGitUrl(d.git.repository_url);
                if (p) {
                  const key = `${p.owner}/${p.repo}`;
                  if (!projectMap.has(key))
                    projectMap.set(key, {
                      project_key: key,
                      project_ref: d.git.repository_url,
                      count: 0,
                    });
                  projectMap.get(key).count++;
                }
              }
            } catch (_e) {}
          }
        }
      }
    }
  } catch (_e) {}
}

function findSubagentsDirs(dir, depth) {
  const out = [];
  if (depth > 3) return out;
  try {
    for (const item of fs.readdirSync(dir)) {
      const fp = path.join(dir, item);
      if (!fs.statSync(fp).isDirectory()) continue;
      if (item === "subagents") out.push(fp);
      else out.push(...findSubagentsDirs(fp, depth + 1));
    }
  } catch (_e) {}
  return out;
}

function scanClaudeProjects(projectMap) {
  const dir = path.join(os.homedir(), ".claude", "projects");
  try {
    for (const subDir of findSubagentsDirs(dir, 0)) {
      const files = fs.readdirSync(subDir).filter((f) => f.endsWith(".jsonl"));
      for (const file of files.slice(0, 100)) {
        try {
          const first = fs.readFileSync(path.join(subDir, file), "utf8").split("\n")[0];
          if (!first) continue;
          const d = JSON.parse(first);
          const name = extractProjectFromCwd(d.cwd);
          if (name) {
            if (!projectMap.has(name))
              projectMap.set(name, {
                project_key: name,
                project_ref: `file://${d.cwd}`,
                count: 0,
              });
            projectMap.get(name).count++;
          }
        } catch (_e) {}
      }
    }
  } catch (_e) {}
}

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

function json(res, data, status) {
  if (res.forkMeta) {
    const local = res.forkMeta.device === 'local' || res.forkMeta.device === res.forkMeta.machine_id;
    res.setHeader('X-TokenTracker-Account-View',local?'0':'1');
    res.setHeader('X-TokenTracker-Account-Fallback',local?'fork-local':'fork-webdav');
    res.setHeader('X-TokenTracker-Sync-Partial',res.forkMeta.partial?'1':'0');
  }
  if (res.forkMeta && data && typeof data === "object" && !Array.isArray(data)) data = {...data,...res.forkMeta};
  // Usage and cost payloads change on every sync, and cost is re-priced on
  // every read (pricing is applied per request, never stored in the queue) —
  // so a cached response can pin stale costs on screen indefinitely. WebView2
  // caches responses that carry no freshness directive, and the dashboard's
  // local fetch path omits `cache: "no-store"`.
  // Endpoints that care already set this header by hand; do it once here so
  // every JSON response is covered.
  res.writeHead(status || 200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// IP check API proxy: dashboard/src/pages/IpCheckPage.jsx is a native React
// page that calls ip.net.coffee's data endpoints (/api/iprisk, /api/geoip,
// /api/dns/result, /favicons, /claude/status.json). Browser-side fetch can't
// hit them cross-origin from the dashboard, so we reverse-proxy /proxy/ipcheck/*
// to https://ip.net.coffee/* and strip embedding-hostile headers.
// (Previously this proxy also served the upstream HTML page for an iframe;
// the iframe and its HTML-rewrite path have been removed.)
// ---------------------------------------------------------------------------

const IP_CHECK_PROXY_PREFIX = "/proxy/ipcheck";
const IP_CHECK_TARGET = "https://ip.net.coffee";

// HTTP hop-by-hop headers (RFC 7230 §6.1) plus headers undici/fetch manages
// internally. Forwarding any of these to `fetch(...)` either silently breaks
// the request (host being wrong) or, on stricter undici versions like the
// 6.24.1 shipped with Node 22.22.2, throws UND_ERR_INVALID_ARG and turns
// every proxied POST into a 502. Keep this set authoritative for every
// reverse-proxy site in this module.
const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
]);

// Strip forbidden + hop-by-hop headers when forwarding an inbound request to
// fetch(). Honours the Connection header's named-headers list (RFC 7230 §6.1)
// so values like `Connection: keep-alive, x-custom` also drop x-custom.
function buildProxyHeaders(headers) {
  const entries =
    headers && typeof headers.entries === "function"
      ? Array.from(headers.entries())
      : Object.entries(headers || {});

  const connectionNamed = new Set();
  const normalized = [];
  for (const [rawKey, rawValue] of entries) {
    if (rawValue == null) continue;
    const key = String(rawKey).toLowerCase();
    normalized.push([key, rawValue]);
    if (key === "connection") {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const v of values) {
        String(v)
          .split(",")
          .map((part) => part.trim().toLowerCase())
          .filter(Boolean)
          .forEach((part) => connectionNamed.add(part));
      }
    }
  }

  const out = {};
  for (const [key, rawValue] of normalized) {
    if (HOP_BY_HOP_HEADERS.has(key) || connectionNamed.has(key)) continue;
    if (Array.isArray(rawValue)) {
      const joined = rawValue.filter((e) => e != null).map(String).join(", ");
      if (joined) out[key] = joined;
      continue;
    }
    out[key] = String(rawValue);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main handler factory
// ---------------------------------------------------------------------------

function createLocalApiHandler({ queuePath, serverVersion = null, trackerDataDir: isolatedTrackerDataDir = null, syncContext = null, credentialPlatform = process.platform }) {
  const qp = queuePath || resolveQueuePath();
  const localUsage = createLocalUsageTransfer({ queuePath: qp, normalizeRow: normalizeQueueRow,
    identity: () => ({ id: getOrCreateMachineId(qp), name: getSystemDeviceName(), platform: process.platform }) });
  async function scopedQueueRows(queuePath, url) {
    const scope = getRequestedUsageScope(url);
    const ownRows = await readQueueData(queuePath);
    const selected = url.searchParams.get("device_id") || "";
    // Only offline IDs select a snapshot; other IDs retain the local fallback.
    const device = selected.startsWith("local:") ? selected : "";
    const view = require('./fork-view');
    const requested = await view.scope(trackerDataDir,url);
    const remotes = await view.remote(trackerDataDir);
    let allRows = device ? await localUsage.view(ownRows, device) :
      process.env.TOKENTRACKER_PERSONAL === "1" || remotes.length || !['all','local',getOrCreateMachineId(qp)].includes(requested) ? await view.buckets(trackerDataDir,url) :
      requested === 'all' ? await localUsage.view(ownRows, '') : ownRows;
    if (process.env.TOKENTRACKER_PERSONAL === "1") allRows = await require("./fork-costs").capture(trackerDataDir,allRows);
    return { scope, allRows, rows: filterRowsByUsageScope(allRows, scope), excludedSources: listExcludedSources(allRows, scope) };
  }
  const normalizedServerVersion = typeof serverVersion === "string" ? serverVersion.trim() : "";

  const localAuthToken = crypto.randomBytes(24).toString("hex");
  const trackerDataDir = isolatedTrackerDataDir || path.dirname(qp);
  const runtimeConfigPath = path.join(path.dirname(qp), "config.json");

  // Local-only runtime view: config.json next to the queue still carries the
  // local fields (debug, httpTimeoutMs, proxy, telemetry, machineId, ...).
  // The InsForge backend fields and their instance-fingerprint / relay-cookie
  // reset logic were removed together with the cloud; only a malformed local
  // config surfaces as configurationError.
  function getRuntime() {
    let config = {};
    let invalid = false;
    try { config = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8")); }
    catch (error) { invalid = error.code !== "ENOENT"; }
    if (!config || typeof config !== "object" || Array.isArray(config)) { config = {}; invalid = true; }
    const runtime = resolveRuntimeConfig({ config: config || {}, env: process.env });
    if (invalid) runtime.configurationError = "invalid_local_config";
    return runtime;
  }

  function isAuthorizedLocalMutation(req) {
    const headerToken = req?.headers?.["x-tokentracker-local-auth"];
    const cookieToken = parseCookieHeader(req?.headers?.cookie).get("tokentracker_local_auth");
    const token = typeof headerToken === "string" && headerToken.trim()
      ? headerToken.trim()
      : cookieToken || "";
    if (!token || token !== localAuthToken) return false;
    return hasAllowedLoopbackOrigin(req?.headers || {});
  }

  // --- WebDAV fork sync (docs/fork/SYNC_DESIGN.md) --------------------------
  const webdavConfigPath = path.join(trackerDataDir, "webdav", "config.json");
  function readWebdavConfigSync() {
    try {
      const parsed = JSON.parse(fs.readFileSync(webdavConfigPath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch { return null; }
  }
  async function writeWebdavConfig(next) {
    fs.mkdirSync(path.dirname(webdavConfigPath), { recursive: true });
    fs.writeFileSync(webdavConfigPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  }
  let webdavSchedulerInstance = null;
  function getWebdavScheduler() {
    if (!webdavSchedulerInstance) {
      const { createWebdavScheduler } = require("./webdav/scheduler");
      const { loadWebdavPassword } = require("./webdav/credential-store");
      webdavSchedulerInstance = createWebdavScheduler({
        trackerDir: trackerDataDir,
        loadPassword: async ({ username, url }) => loadWebdavPassword({ username, url, trackerDir: trackerDataDir, platform: credentialPlatform }),
        getConfig: async () => readWebdavConfigSync(),
        machineIdProvider: async () => getOrCreateMachineId(qp),
      });
    }
    return webdavSchedulerInstance;
  }
  async function webdavStatusSummary() {
    const scheduler = getWebdavScheduler();
    void scheduler; // scheduler instance created lazily; summary reads files only
    const config = readWebdavConfigSync();
    const { loadWebdavPassword } = require("./webdav/credential-store");
    const credentialPresent = Boolean(
      config?.username && await loadWebdavPassword({ username: config.username, url:config.url, trackerDir: trackerDataDir, platform: credentialPlatform }),
    );
    return {
      config: config ? {
        url: config.url || null,
        username: config.username || null,
        directory: config.directory || "tokentracker-fork",
        device_name: config.device_name || null,
        enabled: config.enabled !== false,
        sync_titles: config.sync_titles !== false,
        interval_minutes: Number(config.interval_minutes) || 5,
      } : null,
      credential_present: credentialPresent,
      machine_id: getOrCreateMachineId(qp),
    };
  }

  return async function handleLocalApi(req, res, url) {
    const p = url.pathname;
    if (p.startsWith('/proxy/ipcheck') || /^\/(api\/pets|functions\/tokentracker-(?:pets|skills|achievements|quality-per-dollar))/.test(p)) { json(res,{error:'Not Found'},404); return true; }
    if (p.startsWith('/api/fork/')) {
      if (!isAuthorizedLocalMutation(req)) {json(res,{code:'unauthorized'},401);return true;}
      try {
        const view = require('./fork-view');
        const durable = require('./fork-store');
        if(p==='/api/fork/view') {
          if(req.method==='PUT') {
            const body=JSON.parse((await readBodyLimited(req,4096)).toString());
            const known=await view.devices(trackerDataDir);
            if(!['all','local',...known.map(d=>d.id)].includes(body.device))throw new Error('unknown device');
            await durable.write(path.join(trackerDataDir,'fork-view.json'),{device:body.device});
          } else if(req.method!=='GET'){json(res,{code:'method_not_allowed'},405);return true;}
          const state=await durable.read(path.join(trackerDataDir,'webdav','state.json'),{});
          json(res,{device:await view.scope(trackerDataDir),devices:await view.devices(trackerDataDir),partial:Boolean(state.last_failure||state.partial),last_failure:state.last_failure||null});
        } else if(p==='/api/fork/device-usage' && req.method==='GET') {
          const from=url.searchParams.get('from')||'';
          const to=url.searchParams.get('to')||'';
          const context=getTimeZoneContext(url);
          json(res,await view.deviceUsage(trackerDataDir,(row)=>{
            const day=rowDayKey(row,context);
            return day&&(!from||day>=from)&&(!to||day<=to);
          }));
        } else if(p==='/api/fork/prefs') {
          if(req.method==='POST') {
            const body=JSON.parse((await readBodyLimited(req,16384)).toString());
            const before=await view.preferences(trackerDataDir);
            await require('./fork-prefs').append(trackerDataDir,getOrCreateMachineId(qp),body,before.events);
          } else if(req.method!=='GET'){json(res,{code:'method_not_allowed'},405);return true;}
          const pref=await view.preferences(trackerDataDir);
          require('./pricing').setCustomPrices(pref.prices);
          json(res,pref);
        } else if(p==='/api/fork/reestimate' && req.method==='POST') {
          require('./pricing').setCustomPrices((await view.preferences(trackerDataDir)).prices);
          const rows = await view.buckets(trackerDataDir,url);
          await require('./fork-costs').capture(trackerDataDir,rows,{reestimate:true});
          json(res,{ok:true,rows:rows.length});
        } else if(p==='/api/fork/backup') {
          const backup=require('./fork-backup');
          if(req.method==='GET')json(res,await backup.exportBackup(trackerDataDir,{home:syncContext?.home}));
          else if(req.method==='POST') {
            const body=JSON.parse((await readBodyLimited(req,64*1024*1024)).toString());
            json(res,await backup.restoreBackup(trackerDataDir,body));
          } else json(res,{code:'method_not_allowed'},405);
        } else if(p==='/api/fork/pricing') {
          const pricing=require('./pricing');
          pricing.setCustomPrices((await view.preferences(trackerDataDir)).prices);
          if(req.method==='POST')await pricing.reloadPricing({cachePath:path.join(trackerDataDir,'pricing-cache.json')});
          else if(req.method!=='GET'){json(res,{code:'method_not_allowed'},405);return true;}
          const model=url.searchParams.get('model');
          json(res,{...pricing.getPricingStatus(),...(model?{model:pricing.getModelPricingInfo(model,{source:url.searchParams.get('source')})}:{})});
        } else {json(res,{error:'Not Found'},404);}
      } catch(e){json(res,{code:'fork_request_failed',error:e.message},400);}
      return true;
    }
    if(p.startsWith('/functions/tokentracker-usage-') || p.includes('project-usage') || p.includes('session')) {
      const view=require('./fork-view');
      require('./pricing').setCustomPrices((await view.preferences(trackerDataDir)).prices);
      const state=await require('./fork-store').read(path.join(trackerDataDir,'webdav','state.json'),{});
      res.forkMeta={machine_id:getOrCreateMachineId(qp),device:await view.scope(trackerDataDir,url),partial:Boolean(state.last_failure||state.partial),failed_devices:Object.entries(state.imported||{}).filter(([,v])=>!v.ok).map(([k])=>k)};
    }
    if (p === "/api/webdav/config") {
      if (!isAuthorizedLocalMutation(req)) { json(res, { code: "unauthorized" }, 401); return true; }
      try {
        if (req.method === "GET") {
          json(res, await webdavStatusSummary());
        } else if (req.method === "PUT") {
          const body = JSON.parse((await readBodyLimited(req, 64 * 1024)).toString("utf8"));
          const current = readWebdavConfigSync() || {};
          const next = {
            ...current,
            url: typeof body.url === "string" ? body.url.trim().replace(/\/+$/, "") : current.url || "",
            username: typeof body.username === "string" ? body.username.trim() : current.username || "",
            directory: typeof body.directory === "string" && body.directory.trim()
              ? body.directory.trim() : current.directory || "tokentracker-fork",
            device_name: typeof body.device_name === "string" ? body.device_name.trim() : current.device_name || null,
            sync_titles: typeof body.sync_titles === "boolean" ? body.sync_titles : current.sync_titles !== false,
            enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled !== false,
            interval_minutes: Number(body.interval_minutes) > 0 ? Number(body.interval_minutes) : current.interval_minutes || 5,
          };
          if (!require("./webdav/scheduler").normalizeConfig(next)) throw new Error("Invalid WebDAV configuration (HTTPS required)");
          if (typeof body.password === "string" && body.password.length > 0) {
            const { saveWebdavPassword, clearWebdavPassword } = require("./webdav/credential-store");
            if (body.password === "__clear__") {
              await clearWebdavPassword({ username: next.username, url:next.url, trackerDir: trackerDataDir, platform: credentialPlatform });
            } else {
              await saveWebdavPassword({ username: next.username, url:next.url, password: body.password, trackerDir: trackerDataDir, platform: credentialPlatform });
            }
          }
          if (!require('./webdav/scheduler').normalizeConfig(next)) throw new Error('Invalid WebDAV configuration (HTTPS required)');
          await writeWebdavConfig(next);
          await getWebdavScheduler().resetRetry();
          json(res, await webdavStatusSummary());
        } else json(res, { code: "method_not_allowed" }, 405);
      } catch (error) {
        json(res, { code: "webdav_config_failed", error: String(error?.message || error) }, 400);
      }
      return true;
    }
    if (p === "/api/webdav/test") {
      if (!isAuthorizedLocalMutation(req)) { json(res, { code: "unauthorized" }, 401); return true; }
      if (String(req.method).toUpperCase() !== "POST") { json(res, { code: "method_not_allowed" }, 405); return true; }
      try {
        const { WebDavClient } = require("./webdav/client");
        const { loadWebdavPassword } = require("./webdav/credential-store");
        const config = readWebdavConfigSync();
        if (!config?.url || !config?.username) { json(res, { ok: false, code: "not_configured" }, 400); return true; }
        const password = await loadWebdavPassword({ username: config.username, url:config.url, trackerDir: trackerDataDir, platform: credentialPlatform });
        if (!password) { json(res, { ok: false, code: "missing_credential" }, 400); return true; }
        const client = new WebDavClient({ baseUrl: config.url, username: config.username, password });
        const directory = (typeof config.directory === "string" && config.directory.trim()) || "tokentracker-fork";
        const ensured = await client.ensureCollection(`/${directory}/devices`);
        if (!ensured.ok) { json(res, { ok: false, code: "webdav_http", status: ensured.status }, 502); return true; }
        const capabilities = await client.probeCapabilities("/");
        json(res, { ok: true, dav_class: capabilities.davClass, allowed: capabilities.allowed });
      } catch (error) {
        json(res, { ok: false, code: error.code || "webdav_error", error: String(error?.message || error) }, 502);
      }
      return true;
    }
    if (p === "/api/webdav/sync-now") {
      if (!isAuthorizedLocalMutation(req)) { json(res, { code: "unauthorized" }, 401); return true; }
      if (String(req.method).toUpperCase() !== "POST") { json(res, { code: "method_not_allowed" }, 405); return true; }
      try {
        const result = await getWebdavScheduler().syncNow();
        json(res, result);
      } catch (error) {
        json(res, { ok: false, code: error.code || "webdav_error", error: String(error?.message || error) }, 500);
      }
      return true;
    }
    if (p === "/api/webdav/status") {
      if (!isAuthorizedLocalMutation(req)) { json(res, { code: "unauthorized" }, 401); return true; }
      try {
        const scheduler = getWebdavScheduler();
        const state = await scheduler.readState();
        json(res, { ...(await webdavStatusSummary()), sync: {
          last_success_at: state.last_success_at || null,
          last_failure: state.last_failure || null,
          backoff_until_ms: state.backoff_until_ms || 0,
          paused_auth: Boolean(state.paused_auth),
          docs: state.docs || {},
          imported: state.imported || {},
          notes: state.notes || [],
        } });
      } catch (error) {
        json(res, { code: "webdav_status_failed", error: String(error?.message || error) }, 500);
      }
      return true;
    }
    if (p === "/api/local-usage") {
      if (!isAuthorizedLocalMutation(req)) { json(res, { code: "unauthorized" }, 401); return true; }
      try {
        if (req.method === "GET") {
          const from = url.searchParams.get("from") || "";
          const to = url.searchParams.get("to") || "";
          const context = getTimeZoneContext(url);
          const inRange = (row) => { const day = rowDayKey(row, context); return day && (!from || day >= from) && (!to || day <= to); };
          json(res, await localUsage.devices(await readQueueData(qp), inRange));
        } else if (req.method === "POST") {
          const body = JSON.parse((await readBodyLimited(req, LOCAL_USAGE_MAX_BYTES + 4096)).toString("utf8"));
          if (body.action === "export") json(res, { snapshot: await localUsage.exportSnapshot() });
          else if (body.action === "preview") json(res, await localUsage.preview(body.snapshot));
          else if (body.action === "import") json(res, await localUsage.importSnapshot(body.snapshot, body.token));
          else if (body.action === "remove") { await localUsage.remove(body.machine_id); json(res, { ok: true }); }
          else json(res, { code: "invalid_snapshot" }, 400);
        } else json(res, { code: "method_not_allowed" }, 405);
      } catch (error) {
        json(res, { code: error.code && error.status ? error.code : "transfer_failed" }, error.status || 400);
      }
      return true;
    }
    if (p.startsWith("/functions/tokentracker-usage-") && url.searchParams.get("device_id")?.startsWith("local:")) {
      try { await localUsage.view([], url.searchParams.get("device_id")); }
      catch (error) { json(res, { code: error.code || "transfer_failed" }, error.status || 500); return true; }
    }
    if (p === "/api/runtime-config.js") {
      if (String(req.method).toUpperCase() !== "GET") { json(res, { error: "Method Not Allowed" }, 405); return true; }
      // Cloud descriptor is permanently empty in this fork: the local
      // dashboard still loads this script, but there is no backend to point at.
      const descriptor = { baseUrl: null, anonKey: null, dashboardUrl: null, configurationError: null };
      const value = JSON.stringify(descriptor).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(`window.__TOKENTRACKER_RUNTIME_CONFIG__=${value};`);
      return true;
    }

    if (p === "/api/local-auth") {
      if (String(req.method || "GET").toUpperCase() !== "GET") {
        json(res, { error: "Method Not Allowed" }, 405);
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({
        token: localAuthToken,
        ...(normalizedServerVersion ? { serverVersion: normalizedServerVersion } : {}),
      }));
      return true;
    }

    // --- local Codex-compatible pet assets and package import ---
    const localPetAssetMatch = p.match(/^\/api\/pets\/local\/([a-z0-9-]+)\/spritesheet\.webp$/);
    if (localPetAssetMatch) {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        json(res, { error: "Method Not Allowed" }, 405);
        return true;
      }
      const pet = require("./pet-packages").resolvePetAsset(localPetAssetMatch[1]);
      if (!pet) {
        json(res, { error: "Pet not found" }, 404);
        return true;
      }
      const stat = fs.statSync(pet.spritesheetPath);
      res.writeHead(200, {
        "Content-Type": "image/webp",
        "Content-Length": stat.size,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      if (method === "HEAD") res.end();
      else fs.createReadStream(pet.spritesheetPath).pipe(res);
      return true;
    }

    // Preview asset for a Codex pet that hasn't been imported yet (served from
    // ~/.codex/pets or straight out of the Codex.app bundle).
    const codexPetAssetMatch = p.match(/^\/api\/pets\/codex\/([a-z0-9-]+)\/spritesheet\.webp$/);
    if (codexPetAssetMatch) {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        json(res, { error: "Method Not Allowed" }, 405);
        return true;
      }
      const asset = require("./pet-packages").readCodexImportableAsset(codexPetAssetMatch[1]);
      if (!asset) {
        json(res, { error: "Pet not found" }, 404);
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "image/webp",
        "Content-Length": asset.buffer.length,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      if (method === "HEAD") res.end();
      else res.end(asset.buffer);
      return true;
    }

    if (p === "/api/pets/import") {
      if (String(req.method || "GET").toUpperCase() !== "POST") {
        json(res, { ok: false, error: "Method Not Allowed" }, 405);
        return true;
      }
      if (!isAuthorizedLocalMutation(req)) {
        json(res, { ok: false, error: "Unauthorized" }, 401);
        return true;
      }
      const pets = require("./pet-packages");
      try {
        const body = await readBodyLimited(req, pets.MAX_PACKAGE_BYTES);
        json(res, { ok: true, pet: await pets.importPetZip(body) });
      } catch (error) {
        if (!res.headersSent) json(res, { ok: false, error: error?.message || "Pet import failed" }, 400);
      }
      return true;
    }

    // --- ip-check proxy: reverse-proxy ip.net.coffee (issue #81) ---
    // Lock-down: GET/HEAD only, restricted path prefixes, do not forward
    // browser credentials or fingerprintable headers. Without these limits
    // /proxy/ipcheck is an open reverse-proxy any local process can abuse
    // (exfiltrate dashboard cookies, anonymously POST through user IP).
    if (p.startsWith(`${IP_CHECK_PROXY_PREFIX}/`) || p === IP_CHECK_PROXY_PREFIX) {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        json(res, { error: "Method Not Allowed" }, 405);
        return true;
      }
      const targetPath = p === IP_CHECK_PROXY_PREFIX
        ? "/"
        : p.slice(IP_CHECK_PROXY_PREFIX.length) || "/";
      const ALLOWED_PREFIXES = [
        "/api/geoip/",
        "/api/geoip-batch",
        "/api/iprisk/",
        "/api/dns/result/",
        "/claude/status.json",
        "/favicons/",
        "/ip/",
      ];
      if (!ALLOWED_PREFIXES.some((prefix) => targetPath.startsWith(prefix))) {
        json(res, { error: "Path not allowed" }, 403);
        return true;
      }
      const targetUrl = `${IP_CHECK_TARGET}${targetPath}${url.search || ""}`;
      try {
        // Whitelist forwarded headers — no cookies, no auth, no fingerprintable
        // identity. Only what the upstream needs to negotiate content. Do not
        // set `host` explicitly: undici derives it from the URL, and some
        // versions reject a manual host header on fetch() (same forbidden-
        // header family that has broken proxied POSTs in the past).
        const proxyHeaders = {
          accept: req.headers["accept"] || "*/*",
          "accept-language": req.headers["accept-language"] || "en",
          "accept-encoding": req.headers["accept-encoding"] || "gzip",
          "user-agent": "TokenTracker/IPCheck (https://www.tokentracker.cc)",
          referer: `${IP_CHECK_TARGET}${targetPath}`,
        };

        const proxyRes = await fetch(targetUrl, {
          method,
          headers: proxyHeaders,
          redirect: "manual",
        });

        const stripped = new Set([
          "transfer-encoding",
          "connection",
          "content-length",
          "content-encoding",
          "x-frame-options",
          "content-security-policy",
          "cross-origin-opener-policy",
          "cross-origin-embedder-policy",
          "cross-origin-resource-policy",
        ]);
        const responseHeaders = [...proxyRes.headers.entries()].filter(
          ([k]) => !stripped.has(k.toLowerCase()),
        );

        const resBody = Buffer.from(await proxyRes.arrayBuffer());
        res.writeHead(proxyRes.status, Object.fromEntries(responseHeaders));
        res.end(resBody);
      } catch (e) {
        json(res, { error: `IP check proxy error: ${e?.message || e}` }, 502);
      }
      return true;
    }

    // --- local-sync (POST, local-only) ---
    // Dashboard "Sync Now" / background-refresh trigger. This fork removed the
    // cloud upload path, so the endpoint only kicks a LOCAL `tracker sync
    // --auto` scan and acknowledges immediately: fire-and-forget, no tokens,
    // no backend calls.
    if (p === "/functions/tokentracker-local-sync") {
      if (String(req.method || "GET").toUpperCase() !== "POST") {
        json(res, { ok: false, error: "Method Not Allowed" }, 405);
        return true;
      }
      if (!isAuthorizedLocalMutation(req)) {
        json(res, { ok: false, error: "Unauthorized" }, 401);
        return true;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
      // Keep the strict-boolean contract the dashboard relies on: background /
      // lightweight scans are explicit opt-ins, never truthy-string hints.
      const auto = body.auto === true;
      const background =
        auto && (body.background === true || body.lightweight === true);
      const allLocalSources = background && body.allLocalSources === true;
      runSyncCommand(
        {},
        {
          trackerDataDir: isolatedTrackerDataDir,
          syncContext,
          auto: true,
          background,
          allLocalSources,
        },
      ).catch((e) => {
        console.warn("[LocalAPI] local sync failed:", e?.message || e);
      });
      json(res, { ok: true, local_only: true });
      return true;
    }

    // --- wrapped (year-end summary, à la Spotify Wrapped) ---
    if (p === "/functions/tokentracker-wrapped") {
      const yearParam = url.searchParams.get("year");
      const year = yearParam ? Number(yearParam) : null;
      const { rows, scope, excludedSources } = await scopedQueueRows(qp, url);
      const { aggregateWrapped } = require("./wrapped-aggregator");
      const summary = aggregateWrapped(rows, year ? { year } : {});
      json(res, { scope, excluded_sources: excludedSources, ...summary });
      return true;
    }

    // --- usage-summary ---
    if (p === "/functions/tokentracker-usage-summary") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = await scopedQueueRows(qp, url);
      const allDaily = await aggregateByDay(rows, timeZoneContext);
      const daily = allDaily.filter((d) => d.day >= from && d.day <= to);
      const totals = daily.reduce(
        (acc, r) => {
          acc.total_tokens += r.total_tokens;
          acc.billable_total_tokens += r.billable_total_tokens;
          acc.total_cost_usd += r.total_cost_usd || 0;
          acc.input_tokens += r.input_tokens;
          acc.output_tokens += r.output_tokens;
          acc.cached_input_tokens += r.cached_input_tokens;
          acc.cache_creation_input_tokens += r.cache_creation_input_tokens;
          acc.reasoning_output_tokens += r.reasoning_output_tokens;
          acc.conversation_count += r.conversation_count;
          return acc;
        },
        { total_tokens: 0, billable_total_tokens: 0, total_cost_usd: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, conversation_count: 0 },
      );
      const totalCost = totals.total_cost_usd;

      const todayParts = getZonedParts(new Date(), timeZoneContext);
      const todayStr = formatPartsDayKey(todayParts) || new Date().toISOString().slice(0, 10);

      const shiftDay = (dayStr, delta) => {
        const d = new Date(`${dayStr}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + delta);
        return d.toISOString().slice(0, 10);
      };
      const collectDays = (n) => {
        const out = [];
        for (let i = n - 1; i >= 0; i--) {
          const ds = shiftDay(todayStr, -i);
          const dd = allDaily.find((x) => x.day === ds);
          if (dd) out.push(dd);
        }
        return out;
      };
      const sumDays = (days) =>
        days.reduce((a, r) => {
          a.billable_total_tokens += r.billable_total_tokens;
          a.conversation_count += r.conversation_count;
          return a;
        }, { billable_total_tokens: 0, conversation_count: 0 });

      const l7 = collectDays(7);
      const l30 = collectDays(30);
      const l7t = sumDays(l7);
      const l30t = sumDays(l30);
      const l7fromStr = shiftDay(todayStr, -6);
      const l30fromStr = shiftDay(todayStr, -29);

      json(res, {
        from, to, days: daily.length, scope, excluded_sources: excludedSources,
        totals: { ...totals, total_cost_usd: totalCost.toFixed(6) },
        rolling: {
          last_7d: { from: l7fromStr, to: todayStr, active_days: l7.length, totals: l7t },
          last_30d: { from: l30fromStr, to: todayStr, active_days: l30.length, totals: l30t, avg_per_active_day: l30.length > 0 ? Math.round(l30t.billable_total_tokens / l30.length) : 0 },
        },
      });
      return true;
    }

    // --- usage-daily ---
    if (p === "/functions/tokentracker-usage-daily") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = await scopedQueueRows(qp, url);
      const daily = (await aggregateByDay(rows, timeZoneContext)).filter((d) => d.day >= from && d.day <= to);
      json(res, { from, to, scope, excluded_sources: excludedSources, data: daily });
      return true;
    }

    // --- outcomes (opt-in quality-per-dollar / Effective Tokens; sidecar) ---
    // Reads the optional ~/.tokentracker/tracker/outcomes.jsonl sidecar and
    // joins it to the existing token/$ rows at READ time. Returns
    // available:false with empty arrays when the user hasn't opted in, so the
    // dashboard renders exactly as before. This path NEVER reads or writes
    // queue.jsonl's schema or the sync path (see GitHub #229).
    if (p === "/functions/tokentracker-outcomes") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const {
        readAllOutcomesData,
        computeQualityPerDollar,
      } = require("./outcomes-engine");
      // Refresh the independent metadata-only sidecars before joining. Any
      // scanner failure degrades to the existing manual outcomes file.
      try {
        const { buildSessionAnalytics } = require("./session-analytics");
        const { buildGitOutcomes } = require("./git-outcomes");
        const sessions = await buildSessionAnalytics();
        await buildGitOutcomes(sessions);
      } catch (error) {
        console.error("[outcomes] automatic Git attribution failed:", error?.message || error);
      }
      const outcomes = readAllOutcomesData();
      if (!outcomes.length) {
        json(res, { available: false, from, to, by_model: [], by_tool: [], totals: null });
        return true;
      }
      const { rows, scope, excludedSources } = await scopedQueueRows(qp, url);
      const result = computeQualityPerDollar(rows, outcomes, { from, to });
      json(res, { from, to, scope, excluded_sources: excludedSources, ...result });
      return true;
    }

    // --- metadata-only Claude/Codex session efficiency ---
    if (p === "/functions/tokentracker-session-insights") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const refresh = ["1", "true"].includes(url.searchParams.get("refresh"));
      try {
        const { buildSessionAnalytics, summarizeSessions, sessionsToCsv } = require("./session-analytics");
        const sessions = await require("./fork-view").sessions(trackerDataDir, url, {home: syncContext?.home});
        const wantsCsv = url.searchParams.get("format") === "csv";
        const includeSessions = wantsCsv || ["1", "true"].includes(url.searchParams.get("include_sessions"));
        const result = summarizeSessions(sessions, { from, to, includeSessions, ...getTimeZoneContext(url) });
        if (wantsCsv) {
          const content = sessionsToCsv(result.sessions);
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/csv; charset=utf-8");
          res.setHeader("Content-Disposition", "attachment; filename=tokentracker-sessions.csv");
          res.end(content);
          return true;
        }
        json(res, { from, to, ...result });
      } catch (error) {
        json(res, { available: false, error: error?.message || "Session analytics failed" }, 500);
      }
      return true;
    }

    // --- metadata-only session browser (LOCAL ONLY) ---
    // Unlike session-insights this returns per-session rows that retain the
    // raw session_id + local project path so the dashboard can offer one-click
    // resume. It is intentionally served only from the local API and never
    // proxied to the cloud account view.
    if (p === "/functions/tokentracker-sessions") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const refresh = ["1", "true"].includes(url.searchParams.get("refresh"));
      const limitParam = parseInt(url.searchParams.get("limit") || "0", 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 2000) : 0;
      // This payload contains local paths and resumable session identifiers.
      // The server is loopback-only; additionally prevent browser/proxy caches
      // from retaining the response after the page is closed.
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      try {
        const { buildSessionAnalytics, listSessionsForBrowser } = require("./session-analytics");
        const sessions = await require("./fork-view").sessions(trackerDataDir, url, {home: syncContext?.home});
        const result = listSessionsForBrowser(sessions, { from, to, limit, ...getTimeZoneContext(url) });
        const prefs = await require('./fork-view').preferences(trackerDataDir);
        const includeHidden = ['1','true'].includes(url.searchParams.get('include_hidden'));
        const hidden = new Set(prefs.hidden);
        result.sessions = result.sessions.map(row=> {
          const origin = sessions.find(s=>s.session_hash===row.session_hash);
          const remote=origin?.remote;
          return {...row,device:origin?.device,device_name:origin?.device_name,hidden:hidden.has(row.session_hash),remote:Boolean(remote),...(remote||origin?.restored?{resume_command:null,project_ref:null}:{})};
        }).filter(row=>includeHidden||!row.hidden);
        result.returned_count=result.sessions.length;
        json(res, { from, to, ...result });
      } catch (error) {
        // Node fs errors embed the absolute path ("EACCES ... open '/Users/…'").
        // Keep that out of the HTTP body and log it locally instead.
        console.warn("[local-api] session browser failed:", error?.message || error);
        json(res, { available: false, error: "Session browser failed" }, 500);
      }
      return true;
    }

    // --- fixed context overhead audit (counts and estimates only) ---
    if (p === "/functions/tokentracker-context-health") {
      const { computeContextHealth } = require("./context-health");
      json(res, computeContextHealth({ home: os.homedir(), cwd: process.cwd(), env: process.env }));
      return true;
    }

    // --- usage-heatmap ---
    if (p === "/functions/tokentracker-usage-heatmap") {
      const weeks = parseInt(url.searchParams.get("weeks") || "52", 10);
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = await scopedQueueRows(qp, url);
      const daily = await aggregateByDay(rows, timeZoneContext);
      const todayParts = getZonedParts(new Date(), timeZoneContext);
      const todayStr = formatPartsDayKey(todayParts) || new Date().toISOString().slice(0, 10);
      const end = new Date(`${todayStr}T00:00:00Z`);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - weeks * 7 + 1);
      const from = start.toISOString().slice(0, 10);
      const to = end.toISOString().slice(0, 10);
      const byDay = new Map(daily.map((d) => [d.day, d]));

      const allValues = daily.map((d) => d.billable_total_tokens).filter((v) => v > 0);
      const maxValue = allValues.length > 0 ? Math.max(...allValues) : 0;
      const calcLevel = (v) => {
        if (v <= 0) return 0;
        if (maxValue === 0) return 1;
        const r = v / maxValue;
        if (r <= 0.25) return 1;
        if (r <= 0.5) return 2;
        if (r <= 0.75) return 3;
        return 4;
      };

      // Build cells and group into weeks (array of 7-cell arrays) for the dashboard
      const cells = [];
      const cursor = new Date(start);
      while (cursor <= end) {
        const day = cursor.toISOString().slice(0, 10);
        const data = byDay.get(day);
        const billable = data?.billable_total_tokens || 0;
        cells.push({ day, total_tokens: data?.total_tokens || 0, billable_total_tokens: billable, level: calcLevel(billable), models: data?.models || null });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      const weeksArr = [];
      for (let i = 0; i < cells.length; i += 7) {
        weeksArr.push(cells.slice(i, i + 7));
      }

      let totalCostUsd = 0;
      for (const d of daily) {
        if (d.day >= from && d.day <= to) {
          totalCostUsd += d.total_cost_usd || 0;
        }
      }

      json(res, { 
        from, 
        to, 
        scope, 
        excluded_sources: excludedSources, 
        week_starts_on: "sun", 
        active_days: cells.filter((c) => c.billable_total_tokens > 0).length, 
        streak_days: 0, 
        weeks: weeksArr,
        total_cost_usd: totalCostUsd
      });
      return true;
    }

    // --- usage-model-breakdown ---
    if (p === "/functions/tokentracker-usage-model-breakdown") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows: scopedRows, scope, excludedSources } = await scopedQueueRows(qp, url);
      const pricingRevision = getPricingRevision();
      const bySource = new Map();
      let processed = 0;
      for (const row of scopedRows) {
        if (++processed % AGGREGATION_BATCH_ROWS === 0) await yieldToRequests();
        if (!row.hour_start) continue;
        const day = rowDayKey(row, timeZoneContext);
        if (day < from || day > to) continue;
        const src = row.source || "unknown";
        const mdl = row.model || "unknown";
        if (!bySource.has(src))
          bySource.set(src, { source: src, source_scope: getSourceScope(src), totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_cost_usd: "0" }, models: new Map() });
        const sa = bySource.get(src);
        sa.totals.total_tokens += row.total_tokens || 0;
        sa.totals.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
        sa.totals.input_tokens += row.input_tokens || 0;
        sa.totals.output_tokens += row.output_tokens || 0;
        sa.totals.cached_input_tokens += row.cached_input_tokens || 0;
        sa.totals.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        sa.totals.reasoning_output_tokens += row.reasoning_output_tokens || 0;
        if (!sa.models.has(mdl))
          sa.models.set(mdl, { model: mdl, model_id: mdl, pricing: getModelPricingInfo(mdl, { source: src }), totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_cost_usd: "0" } });
        const ma = sa.models.get(mdl);
        const reportedCost = ["grok", "cline"].includes(src) && Number(row.total_cost_usd) > 0;
        const costSource = reportedCost ? "provider_reported" : "model_pricing";
        ma.cost_source = ma.cost_source && ma.cost_source !== costSource ? "mixed" : costSource;
        ma.totals.total_tokens += row.total_tokens || 0;
        ma.totals.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
        ma.totals.input_tokens += row.input_tokens || 0;
        ma.totals.output_tokens += row.output_tokens || 0;
        ma.totals.cached_input_tokens += row.cached_input_tokens || 0;
        ma.totals.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        ma.totals.reasoning_output_tokens += row.reasoning_output_tokens || 0;
        // Price each row, exactly as aggregateByDay does for the hero (#653).
        // computeRowCost is not linear for models with a Fast tier or
        // long-context rates: priority_* / long_context_* mark a subset of the
        // base columns rather than adding volume, so they survive only while the
        // row is intact. Summing the base columns first and pricing once silently
        // dropped every premium — same tokens, fewer dollars than the hero.
        ma.totals.total_cost_usd = Number(ma.totals.total_cost_usd || 0) + computeRowCost(row);
      }
      if (pricingRevision !== getPricingRevision()) return handleLocalApi(req, res, url);

      const sources = Array.from(bySource.values()).map((s) => {
        s.models = Array.from(s.models.values())
          .map((m) => ({
            ...m,
            totals: { ...m.totals, total_cost_usd: Number(m.totals.total_cost_usd || 0).toFixed(6) },
          }))
          .sort((a, b) => b.totals.total_tokens - a.totals.total_tokens);
        const sourceCost = s.models.reduce((sum, m) => sum + Number(m.totals.total_cost_usd), 0);
        s.totals.total_cost_usd = sourceCost.toFixed(6);
        return s;
      });

      json(res, {
        from, to, days: 0, scope, excluded_sources: excludedSources, sources,
        pricing: { model: "per-model", pricing_mode: "per_token_type", source: "litellm", effective_from: new Date().toISOString().slice(0, 10) },
      });
      return true;
    }

    // --- usage-category-breakdown (Claude + Codex + Grok) ---
    // Claude: splits historical Claude usage into seven semantic categories
    // mirroring Claude Code's /context view (approx).
    // Codex/Grok: tool-oriented breakdown, attributing per-turn token
    // totals to observed tool calls (heuristic).
    if (p === "/functions/tokentracker-usage-category-breakdown") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const requestedSource = (url.searchParams.get("source") || "claude").trim().toLowerCase();
      const selected = url.searchParams.get("device_id") || "";
      if (selected.startsWith("local:") ? selected !== `local:${getOrCreateMachineId(qp)}` : !selected && await localUsage.hasImports()) {
        json(res, { from, to, ...unsupportedCategoryPayload(requestedSource), reason: "local_history_only" });
        return true;
      }
      if (requestedSource === "claude") {
        try {
          const result = await computeClaudeCategoryBreakdown({ from, to, projectDir: process.cwd() });
          json(res, { from, to, ...result });
        } catch (e) {
          console.error("[LocalAPI] usage-category-breakdown:", e?.message || e);
          json(res, { from, to, ...unsupportedCategoryPayload("claude"), error: "compute_failed" }, 500);
        }
        return true;
      }

      if (requestedSource === "codex") {
        try {
          const timeZoneContext = getTimeZoneContext(url);
          const result = await computeCodexContextBreakdown({
            from,
            to,
            top: 50,
            timeZoneContext,
          });
          if (!Number(result?.totals?.total_tokens || 0)) {
            const fallback = buildCodexCategoryFallbackFromQueue(await readQueueData(qp), {
              from,
              to,
              timeZoneContext,
            });
            json(res, { from, to, ...fallback });
            return true;
          }
          json(res, { from, to, ...result });
        } catch (e) {
          console.error("[LocalAPI] usage-category-breakdown(codex):", e?.message || e);
          json(res, { from, to, ...unsupportedCategoryPayload("codex"), error: "compute_failed" }, 500);
        }
        return true;
      }

      if (requestedSource === "grok") {
        try {
          const timeZoneContext = getTimeZoneContext(url);
          const result = await computeGrokContextBreakdown({
            from,
            to,
            top: 50,
            timeZoneContext,
          });
          json(res, { from, to, ...result });
        } catch (e) {
          console.error("[LocalAPI] usage-category-breakdown(grok):", e?.message || e);
          json(res, { from, to, ...unsupportedCategoryPayload("grok"), error: "compute_failed" }, 500);
        }
        return true;
      }

      json(res, { from, to, ...unsupportedCategoryPayload(requestedSource) });
      return true;
    }

    // --- project-usage-summary ---
    if (p === "/functions/tokentracker-project-usage-summary") {
      // Use the per-project bucket log that rollout.js emits — it already
      // carries the actual tokens attributed to each (project_key, source,
      // hour_start). Falling back to "session-file count × total tokens"
      // (the old behavior) produced pure fiction: every short-and-hot
      // project got the same weight as every long-and-cold one.
      const limitParam = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.floor(limitParam), PROJECT_USAGE_MAX_ENTRIES)
        : PROJECT_USAGE_MAX_ENTRIES;
      const { timeZoneContext, hasRange, dayInRange, projectRows } =
        await readProjectUsageContext(qp, url);

      const aggregateEntries = async (rows, keyOf, refOf) => {
        const byKey = new Map();
        let processed = 0;
        for (const row of rows) {
          if (++processed % AGGREGATION_BATCH_ROWS === 0) await yieldToRequests();
          if (hasRange && !dayInRange(rowDayKey(row, timeZoneContext))) continue;
          const key = keyOf(row);
          if (!byKey.has(key)) {
            byKey.set(key, {
              project_key: key,
              project_ref: refOf(row),
              total_tokens: 0,
              billable_total_tokens: 0,
              input_tokens: 0,
              output_tokens: 0,
              cached_input_tokens: 0,
              cache_creation_input_tokens: 0,
              reasoning_output_tokens: 0,
              conversation_count: 0,
              sourceTotals: new Map(),
            });
          }
          const agg = byKey.get(key);
          agg.total_tokens += Number(row.total_tokens || 0);
          agg.billable_total_tokens += Number(
            row.billable_total_tokens ?? row.total_tokens ?? 0,
          );
          agg.input_tokens += Number(row.input_tokens || 0);
          agg.output_tokens += Number(row.output_tokens || 0);
          agg.cached_input_tokens += Number(row.cached_input_tokens || 0);
          agg.cache_creation_input_tokens += Number(row.cache_creation_input_tokens || 0);
          agg.reasoning_output_tokens += Number(row.reasoning_output_tokens || 0);
          agg.conversation_count += Number(row.conversation_count || 0);
          if (!agg.project_ref) agg.project_ref = refOf(row);
          const src = row.source || "unknown";
          agg.sourceTotals.set(
            src,
            (agg.sourceTotals.get(src) || 0) + Number(row.total_tokens || 0),
          );
        }
        return Array.from(byKey.values())
          .sort((a, b) => b.billable_total_tokens - a.billable_total_tokens)
          .slice(0, limit)
          .map(({ sourceTotals, ...entry }) => ({
            ...entry,
            total_tokens: String(entry.total_tokens),
            billable_total_tokens: String(entry.billable_total_tokens),
            sources: Array.from(sourceTotals.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([source, totalTokens]) => ({ source, total_tokens: totalTokens })),
          }));
      };

      let entries = await aggregateEntries(
        projectRows,
        (row) => row.project_key || "unknown",
        (row) => row.project_ref || "",
      );

      // If no project-attributed rows exist yet (user hasn't synced project
      // attribution, or never used a project-capable CLI), fall back to
      // per-source aggregation over the main queue so the panel isn't
      // totally empty. This path used to also exist for the non-empty case
      // and produce wrong numbers; keep it only as the empty fallback.
      if (entries.length === 0 && projectRows.length === 0) {
        entries = await aggregateEntries(
          await readQueueData(qp),
          (row) => row.source || "unknown",
          // Synthetic source-only row: leave project_ref empty rather than
          // fabricating `https://${src}.ai`, which resolves to unrelated
          // domains (e.g. codex.ai, cursor.ai) and was sent to the
          // dashboard as a clickable href before v0.11.1 / this commit.
          () => "",
        );
      }

      json(res, { generated_at: new Date().toISOString(), entries });
      return true;
    }

    // --- project-usage-detail ---
    // Per-project drill-down for the Project Usage modal: daily series,
    // per-source breakdown, and aggregate stats. Everything comes from the
    // local project bucket log — no external requests, no git access.
    if (p === "/functions/tokentracker-project-usage-detail") {
      const projectKey = url.searchParams.get("project_key") || "";
      if (!projectKey) {
        json(res, { error: "missing_project_key" }, 400);
        return true;
      }
      const { from, to, timeZoneContext, dayInRange, projectRows } =
        await readProjectUsageContext(qp, url);

      const emptyMeasures = () => ({
        total_tokens: 0,
        billable_total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      });
      const addMeasures = (acc, row) => {
        acc.total_tokens += Number(row.total_tokens || 0);
        acc.billable_total_tokens += Number(
          row.billable_total_tokens ?? row.total_tokens ?? 0,
        );
        acc.input_tokens += Number(row.input_tokens || 0);
        acc.output_tokens += Number(row.output_tokens || 0);
        acc.cached_input_tokens += Number(row.cached_input_tokens || 0);
        acc.cache_creation_input_tokens += Number(row.cache_creation_input_tokens || 0);
        acc.reasoning_output_tokens += Number(row.reasoning_output_tokens || 0);
        acc.conversation_count += Number(row.conversation_count || 0);
      };

      let projectRef = "";
      const totals = emptyMeasures();
      const byDay = new Map();
      const bySource = new Map();
      let rangeTotalTokens = 0;
      let processed = 0;
      for (const row of projectRows) {
        if (++processed % AGGREGATION_BATCH_ROWS === 0) await yieldToRequests();
        const day = rowDayKey(row, timeZoneContext);
        if (!dayInRange(day)) continue;
        rangeTotalTokens += Number(row.total_tokens || 0);
        if (row.project_key !== projectKey) continue;
        if (!projectRef && row.project_ref) projectRef = row.project_ref;
        addMeasures(totals, row);

        const src = row.source || "unknown";
        if (day) {
          // `models` keyed by source (project rows carry no model column) —
          // it feeds TrendMonitor's stacked-segment slot so the modal chart
          // colors by provider exactly like the dashboard's Usage Trend.
          if (!byDay.has(day)) byDay.set(day, { day, ...emptyMeasures(), models: {} });
          const dayAgg = byDay.get(day);
          addMeasures(dayAgg, row);
          dayAgg.models[src] = (dayAgg.models[src] || 0) + Number(row.total_tokens || 0);
        }

        if (!bySource.has(src)) {
          bySource.set(src, {
            source: src,
            total_tokens: 0,
            conversation_count: 0,
            dayKeys: new Set(),
          });
        }
        const srcAgg = bySource.get(src);
        srcAgg.total_tokens += Number(row.total_tokens || 0);
        srcAgg.conversation_count += Number(row.conversation_count || 0);
        if (day) srcAgg.dayKeys.add(day);
      }

      json(res, {
        generated_at: new Date().toISOString(),
        from,
        to,
        project_key: projectKey,
        project_ref: projectRef,
        totals,
        days_active: byDay.size,
        // All-project total over the same range so the client can render
        // "share of everything you tracked" without a second request.
        range_total_tokens: rangeTotalTokens,
        daily: Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day)),
        sources: Array.from(bySource.values())
          .sort((a, b) => b.total_tokens - a.total_tokens)
          .map(({ dayKeys, ...src }) => ({ ...src, days_active: dayKeys.size })),
      });
      return true;
    }

    // --- outbound proxy preference (manual / system / off) ---
    // Persisted on config.json next to the queue. GET is unauthenticated so the
    // settings page can probe availability; POST requires local-auth.
    if (p === "/functions/tokentracker-proxy-config") {
      const {
        normalizeProxyConfig,
        parseProxyPayload,
      } = require("./proxy-settings");
      const {
        applyUndiciProxyIfNeeded,
        getLastProxyApplyError,
        resolveEffectiveProxySource,
        invalidateSystemProxyCache,
      } = require("./proxy-env");
      const { writeFileAtomic, chmod600IfPossible } = require("./fs");
      const configPath = path.join(path.dirname(qp), "config.json");
      const readConfig = () => {
        try {
          const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
          return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
          return {};
        }
      };
      const writeConfig = async (next) => {
        await writeFileAtomic(configPath, JSON.stringify(next, null, 2));
        await chmod600IfPossible(configPath);
      };
      const toResponse = (configObj) => {
        const normalized = normalizeProxyConfig(configObj?.proxy);
        const effective = resolveEffectiveProxySource({
          env: process.env,
          proxyConfig: configObj?.proxy,
        });
        return {
          mode: normalized.mode,
          protocol: normalized.protocol,
          host: normalized.host,
          port: normalized.port,
          effective: effective.source,
          applyError: getLastProxyApplyError(),
        };
      };
      const method = String(req.method || "GET").toUpperCase();
      if (method === "GET") {
        json(res, toResponse(readConfig()));
        return true;
      }
      if (method === "POST" || method === "PUT") {
        if (!isAuthorizedLocalMutation(req)) {
          json(res, { ok: false, error: "Unauthorized" }, 401);
          return true;
        }
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          json(res, { ok: false, error: "invalid JSON" }, 400);
          return true;
        }
        const parsed = parseProxyPayload(body);
        if (!parsed.ok) {
          json(res, { ok: false, error: parsed.error }, 400);
          return true;
        }
        const current = readConfig();
        const prevProxy = current.proxy && typeof current.proxy === "object" && !Array.isArray(current.proxy)
          ? current.proxy
          : {};
        current.proxy = {
          ...prevProxy,
          mode: parsed.value.mode,
          protocol: parsed.value.protocol,
          host: parsed.value.host,
          port: parsed.value.port,
        };
        try {
          await writeConfig(current);
        } catch (error) {
          json(res, { ok: false, error: error?.message || "failed to save proxy config" }, 500);
          return true;
        }
        invalidateSystemProxyCache();
        const applyResult = applyUndiciProxyIfNeeded({ proxyConfig: current.proxy });
        json(res, {
          ok: applyResult?.ok !== false,
          unprotected: applyResult?.unprotected === true,
          ...toResponse(current),
        });
        return true;
      }
      json(res, { error: "Method Not Allowed" }, 405);
      return true;
    }

    if (p === "/functions/tokentracker-proxy-test") {
      const { parseProxyPayload, buildProxyUrl } = require("./proxy-settings");
      const { runProxyConnectivityTest } = require("./proxy-env");
      if (String(req.method || "GET").toUpperCase() !== "POST") {
        json(res, { error: "Method Not Allowed" }, 405);
        return true;
      }
      if (!isAuthorizedLocalMutation(req)) {
        json(res, { ok: false, error: "Unauthorized" }, 401);
        return true;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        json(res, { ok: false, error: "invalid JSON" }, 400);
        return true;
      }
      const parsed = parseProxyPayload({ ...body, mode: "manual" });
      if (!parsed.ok) {
        json(res, { ok: false, error: parsed.error }, 400);
        return true;
      }
      const proxyUrl = buildProxyUrl({ ...parsed.value, mode: "manual" });
      const configPath = path.join(path.dirname(qp), "config.json");
      let config = {};
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf8")) || {};
      } catch {
        config = {};
      }
      const runtime = resolveRuntimeConfig({ config, env: process.env });
      const targetUrl = runtime.dashboardUrl || runtime.baseUrl;
      const result = await runProxyConnectivityTest({
        proxyUrl,
        targetUrl,
        timeoutMs: 5000,
      });
      json(res, result);
      return true;
    }

    // --- machine-id (stable per-machine device identity) ---
    // Local usage transfer between machines keys a device on the MACHINE, not
    // the browser — see getOrCreateMachineId above.
    if (p === "/functions/tokentracker-machine-id") {
      json(res, {
        machineId: getOrCreateMachineId(qp),
        deviceName: getSystemDeviceName(),
      });
      return true;
    }

    // --- usage-hourly (stub for day-view) ---
    if (p === "/functions/tokentracker-usage-hourly") {
      const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = await scopedQueueRows(qp, url);
      const data = await aggregateHourlyByDay(rows, day, timeZoneContext);
      json(res, { day, scope, excluded_sources: excludedSources, data });
      return true;
    }

    // --- usage-monthly (stub for trend view) ---
    if (p === "/functions/tokentracker-usage-monthly") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const timeZoneContext = getTimeZoneContext(url);
      const { rows, scope, excludedSources } = await scopedQueueRows(qp, url);
      const byMonth = new Map();
      let processed = 0;
      for (const row of rows) {
        if (++processed % AGGREGATION_BATCH_ROWS === 0) await yieldToRequests();
        if (!row.hour_start) continue;
        const day = rowDayKey(row, timeZoneContext);
        if (!day || day < from || day > to) continue;
        const month = day.slice(0, 7);
        if (!byMonth.has(month))
          byMonth.set(month, { month, total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, conversation_count: 0 });
        const a = byMonth.get(month);
        a.total_tokens += row.total_tokens || 0;
        a.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
        a.input_tokens += row.input_tokens || 0;
        a.output_tokens += row.output_tokens || 0;
        a.cached_input_tokens += row.cached_input_tokens || 0;
        a.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        a.reasoning_output_tokens += row.reasoning_output_tokens || 0;
        a.conversation_count += row.conversation_count || 0;

        if (!a.models) {
          a.models = {};
        }
        const model = row.model || "unknown";
        a.models[model] = (a.models[model] || 0) + (row.total_tokens || 0);
      }
      json(res, { from, to, scope, excluded_sources: excludedSources, data: Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month)) });
      return true;
    }

    // --- Codex-compatible pet manager ---
    if (p === "/functions/tokentracker-pets") {
      const method = String(req.method || "GET").toUpperCase();
      const pets = require("./pet-packages");
      try {
        if (method === "GET") {
          if (url.searchParams.get("scope") === "codex") {
            const importable = pets.listCodexImportablePets();
            json(res, { importable, codexDetected: importable.length > 0 });
            return true;
          }
          json(res, {
            pets: pets.listInstalledPets(),
            hiddenBuiltinIds: pets.readHiddenBuiltinIds(),
          });
          return true;
        }
        if (method === "POST") {
          if (!isAuthorizedLocalMutation(req)) {
            json(res, { ok: false, error: "Unauthorized" }, 401);
            return true;
          }
          const body = await readJsonBody(req);
          if (body?.action === "install_url") {
            json(res, { ok: true, pet: await pets.installFromCodexPets(body.url || body.id) });
            return true;
          }
          if (body?.action === "remove") {
            json(res, { ok: true, ...pets.removeInstalledPet(body.id) });
            return true;
          }
          if (body?.action === "import_codex") {
            json(res, { ok: true, ...pets.importFromCodex(body.ids) });
            return true;
          }
          json(res, { ok: false, error: "Unknown pets action" }, 400);
          return true;
        }
        json(res, { ok: false, error: "Method Not Allowed" }, 405);
      } catch (error) {
        json(res, { ok: false, error: error?.message || "Pet operation failed" }, 400);
      }
      return true;
    }

    // --- subscription manager (manual billing plans, issue #460) ---
    // User-entered renewal/expiry dates. Local-only store that lives next to
    // queue.jsonl; distinct from usage-limits window resets and the
    // auto-detected subscriptions in subscriptions.js.
    if (p === "/functions/tokentracker-subscription-manager") {
      const method = String(req.method || "GET").toUpperCase();
      const manager = require("./subscription-manager");
      const trackerDir = path.dirname(qp);
      try {
        if (method === "GET") {
          json(res, { subscriptions: await manager.listSubscriptions({ trackerDir }) });
          return true;
        }
        if (method === "POST") {
          if (!isAuthorizedLocalMutation(req)) {
            json(res, { ok: false, error: "Unauthorized" }, 401);
            return true;
          }
          const body = await readJsonBody(req);
          if (body?.action === "create") {
            json(res, {
              ok: true,
              subscription: await manager.createSubscription({
                trackerDir: trackerDataDir,
                fields: body.subscription || body,
              }),
            });
            return true;
          }
          if (body?.action === "update") {
            json(res, {
              ok: true,
              subscription: await manager.updateSubscription({
                trackerDir: trackerDataDir,
                id: body.id,
                fields: body.subscription || body,
              }),
            });
            return true;
          }
          if (body?.action === "delete") {
            json(res, {
              ok: true,
              ...(await manager.deleteSubscription({ trackerDir, id: body.id })),
            });
            return true;
          }
          json(res, { ok: false, error: "Unknown subscription-manager action" }, 400);
          return true;
        }
        json(res, { ok: false, error: "Method Not Allowed" }, 405);
      } catch (error) {
        json(res, { ok: false, error: error?.message || "Subscription operation failed" }, 400);
      }
      return true;
    }

    // --- skills manager ---
    if (p === "/functions/tokentracker-skills") {
      const method = String(req.method || "GET").toUpperCase();
      const skills = require("./skills-manager");
      try {
        if (method === "GET") {
          const mode = url.searchParams.get("mode") || "installed";
          if (mode === "installed") {
            json(res, { targets: skills.targetList(), skills: skills.listInstalledSkills() });
            return true;
          }
          if (mode === "repos") {
            json(res, { repos: skills.listRepos() });
            return true;
          }
          if (mode === "discover") {
            const force = url.searchParams.get("force") === "1";
            json(res, await skills.discoverSkills({ force }));
            return true;
          }
          if (mode === "search") {
            const data = await skills.searchSkillsSh(
              url.searchParams.get("q") || "",
              Number(url.searchParams.get("limit") || 20),
              Number(url.searchParams.get("offset") || 0),
            );
            json(res, data);
            return true;
          }
          if (mode === "popular") {
            const force = url.searchParams.get("force") === "1";
            json(res, await skills.fetchPopularSkillsSh({ force }));
            return true;
          }
          if (mode === "updates") {
            const force = url.searchParams.get("force") === "1";
            json(res, await skills.checkUpdates({ force }));
            return true;
          }
          if (mode === "activity") {
            const limit = Number(url.searchParams.get("limit") || 50);
            json(res, { activity: skills.readActivity(limit) });
            return true;
          }
          if (mode === "skill_usage") {
            const force = url.searchParams.get("force") === "1";
            const usage = await require("./skill-usage").scanSkillUsage({ force });
            await ensurePricingLoaded();
            // Join raw per-skill aggregates against installed skills so we can
            // separate user-installed skills (where "dead weight" = unused) from
            // Claude Code built-in tools (bash/agent/…), which dominate the logs
            // and are NOT uninstallable. Cost is priced per-model (source=claude).
            const installed = skills.listInstalledSkills();
            const skillDirectoryLeaf = (value) =>
              String(value || "").replace(/\\/g, "/").split("/").filter(Boolean).pop()?.trim().toLowerCase() || "";
            const leafCounts = new Map();
            for (const s of installed) {
              const leaf = skillDirectoryLeaf(s.directory);
              if (leaf) leafCounts.set(leaf, (leafCounts.get(leaf) || 0) + 1);
            }
            const installedByDirectory = new Map();
            const installedByLeaf = new Map();
            const nameCounts = new Map();
            const installedByName = new Map();
            for (const s of installed) {
              const dir = String(s.directory || "").trim().toLowerCase();
              if (dir) installedByDirectory.set(dir, s);
              const leaf = skillDirectoryLeaf(s.directory);
              if (leaf && leafCounts.get(leaf) === 1) installedByLeaf.set(leaf, s);
              const name = String(s.name || "").trim().toLowerCase();
              if (name) {
                nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
                if (!installedByName.has(name)) installedByName.set(name, s);
              }
            }
            const findInstalledSkill = (value) => {
              const norm = String(value || "").trim().toLowerCase();
              if (!norm) return null;
              if (installedByDirectory.has(norm)) return installedByDirectory.get(norm);
              if (installedByLeaf.has(norm)) return installedByLeaf.get(norm);
              if (nameCounts.get(norm) === 1) return installedByName.get(norm);
              if (leafCounts.get(norm) > 1) return null;
              return null;
            };
            const usedSkillIds = new Set();
            const priced = usage.skills.map((entry) => {
              let cost = 0;
              for (const [model, tokens] of Object.entries(entry.models || {})) {
                cost += computeRowCost({ ...tokens, model, source: "claude" });
              }
              const match = findInstalledSkill(entry.skill);
              if (match?.id) usedSkillIds.add(match.id);
              return {
                skill: entry.skill,
                invocations: entry.invocations,
                lastUsedAt: entry.lastUsedAt,
                tokens: entry.tokens,
                cost,
                installed: Boolean(match),
                skillId: match?.id || null,
                directory: match?.directory || null,
              };
            });
            // Installed skills with zero invocations = dead-weight candidates.
            const unusedInstalled = installed
              .filter((s) => !s.readOnly && !usedSkillIds.has(s.id))
              .map((s) => ({ skillId: s.id, directory: s.directory, name: s.name }));
            json(res, {
              generatedAt: usage.generatedAt,
              scannedFiles: usage.scannedFiles,
              totalInvocations: usage.totalInvocations,
              cached: usage.cached,
              skills: priced,
              unusedInstalled,
            });
            return true;
          }
          json(res, { error: "Unknown skills mode" }, 400);
          return true;
        }

        if (method === "POST") {
          if (!isAuthorizedLocalMutation(req)) {
            json(res, { ok: false, error: "Unauthorized" }, 401);
            return true;
          }
          const body = await readJsonBody(req);
          const action = String(body?.action || "");
          if (action === "install") {
            json(res, { ok: true, skill: await skills.installSkill(body.skill, body.targets || ["claude", "codex"]) });
            return true;
          }
          if (action === "update_all") {
            // Partial success is normal, so this reports per-skill rather than failing.
            json(res, { ok: true, ...(await skills.updateSkills(Array.isArray(body.ids) ? body.ids : [])) });
            return true;
          }
          if (action === "uninstall") {
            json(res, { ok: true, ...(skills.uninstallSkill(body.id) || {}) });
            return true;
          }
          if (action === "restore") {
            json(res, { ok: true, skill: skills.restoreSkill(body.id) });
            return true;
          }
          if (action === "set_targets") {
            json(res, { ok: true, skill: skills.setSkillTargets(body.id, body.targets || []) });
            return true;
          }
          if (action === "import_local") {
            json(res, { ok: true, skill: skills.importLocalSkill(body.directory, body.targets || []) });
            return true;
          }
          if (action === "delete_local") {
            json(res, { ok: true, ...(skills.deleteLocalSkill(body.directory, body.targets || []) || {}) });
            return true;
          }
          if (action === "add_repo") {
            json(res, { ok: true, repo: skills.addRepo(body.repo) });
            return true;
          }
          if (action === "remove_repo") {
            json(res, { ok: true, ...(skills.removeRepo(body.owner, body.name) || {}) });
            return true;
          }
          json(res, { ok: false, error: "Unknown skills action" }, 400);
          return true;
        }

        json(res, { ok: false, error: "Method Not Allowed" }, 405);
      } catch (e) {
        json(res, { ok: false, error: e?.message || "Unknown skills error" }, 500);
      }
      return true;
    }

    // --- achievements (local badges) ---
    if (p === "/functions/tokentracker-achievements") {
      const timeZoneContext = getTimeZoneContext(url);
      const queueRows = await readQueueData(qp);
      const { projectRows } = await readProjectUsageContext(qp, url);
      json(res, {
        generated_at: new Date().toISOString(),
        achievements: computeLocalAchievements(queueRows, projectRows, { timeZoneContext }),
      });
      return true;
    }

    // --- usage-limits ---
    if (p === "/functions/tokentracker-usage-limits") {
      const { getUsageLimits, resetUsageLimitsCache } = require("./usage-limits");
      try {
        // Devin quota is opt-in (Settings > Usage & Limits > Providers). An
        // explicit devin=1 without local authentication is rejected before any
        // cache reset or provider work — silently downgrading it to a disabled
        // response would misreport an enabled client as a disabled provider.
        // Authorization is evaluated unconditionally so the check never depends
        // on the user-controlled opt-in flag itself.
        const localAuthorized = isAuthorizedLocalMutation(req);
        const devinParam = url.searchParams.get("devin");
        const devinEnabled = devinParam === "1" || devinParam === "true";
        if (devinEnabled && !localAuthorized) {
          json(res, { error: "Unauthorized" }, 401);
          return true;
        }
        const refreshParam = url.searchParams.get("refresh");
        const forceRefresh = refreshParam === "1" || refreshParam === "true";
        if (forceRefresh) {
          resetUsageLimitsCache();
        }
        const data = await getUsageLimits({
          home: os.homedir(),
          trackerDir: trackerDataDir,
          env: process.env,
          platform: process.platform,
          // Punches through the Claude disk fresh-cache (but not the 429
          // cooldown) — an explicit user refresh should hit upstream.
          forceRefresh,
          devinEnabled,
        });
        json(res, data);
      } catch (e) {
        json(res, { error: e?.message || "Unknown error" }, 500);
      }
      return true;
    }

    return false;
  };
}

module.exports = {
  createLocalApiHandler,
  resolveQueuePath,
  // Exported for cross-consumer tests (pricing + native contract lock).
  MODEL_PRICING,
  getModelPricing,
  computeRowCost,
  ensurePricingLoaded,
  // Shared legacy-row correction so every queue reader (main queue, project
  // queue, wrapped aggregator) reports the same numbers for the same data.
  normalizeQueueRow,
  // Machine-stable identity (config.json machineId) — used by local usage
  // transfer and the machine-id endpoint; the hostname is only a
  // human-readable label.
  getOrCreateMachineId,
  computeStableMachineId,
  getSystemDeviceName,
  // Local achievement compute — exported for test/local-achievements.test.js.
  computeLocalAchievements,
  LOCAL_BADGE_THRESHOLDS,
};
