// Explicit wire schema: unknown fields never leave the device.
const crypto = require("node:crypto");
const COUNTS = [
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
const SESSION_NUMBERS = [
  "duration_ms",
  "active_ms",
  "turns",
  "edit_turns",
  "retry_turns",
  "subagent_calls",
  "fork_frozen_cost_usd",
  "total_tokens",
  "cost_usd",
  "cost_per_edit",
  "tokens_per_edit",
  "usage_events",
  "model_calls",
  "api_duration_ms",
  "context_tokens_used",
  "context_window_tokens",
  "context_usage_percent",
  "tool_calls",
  "tool_failures",
  "error_count",
  "compaction_count",
  ...COUNTS,
];
function safeText(value, max = 300) {
  if (typeof value !== "string") return null;
  if (
    /:\/\/[^\s/@]+:[^\s/@]+@|(?:token|password|api[_-]?key|authorization|cookie)\s*[:=]|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+|(?:^|\s)(?:\/[^\s/]+\/|~[\/\\]|[A-Za-z]:\\)/i.test(
      value,
    )
  )
    return null;
  return value.slice(0, max);
}
function numbers(row, keys) {
  const out = {};
  for (const k of keys)
    if (typeof row?.[k] === "number" && Number.isFinite(row[k]) && row[k] >= 0)
      out[k] = row[k];
  return out;
}
function projectIdentity(row, device) {
  const ref = safeText(row.project_ref, 1000);
  // Upstream canonical refs (owner/repo) can be shared; paths are local identities.
  if (
    ref &&
    !ref.startsWith("/") &&
    !ref.includes("\\") &&
    !/^[A-Za-z]:/.test(ref)
  ) {
    const normalized = ref
      .replace(/^git@([^:]+):/, "$1/")
      .replace(/^https?:\/\//, "")
      .replace(/\.git\/?$/, "")
      .replace(/\/+$/, "");
    if (/^[\w.-]+(?:\/[\w.-]+)+$/.test(normalized))
      return normalized.toLowerCase().replace(/^github\.com\//, "");
  }
  if (
    typeof row.project_key === "string" &&
    ((row.device && /^[\w.:-]+(?:\/[\w.:-]+)*$/.test(row.project_key)) ||
      /^(git:|local:)/.test(row.project_key))
  )
    return row.project_key;
  return `local:${device}:${crypto
    .createHash("sha256")
    .update(String(row.project_ref || row.project_key || "unknown"))
    .digest("hex")
    .slice(0, 24)}`;
}
function bucket(row, device) {
  if (row?.kind === "account_session_state") {
    const out = {};
    for (const k of [
      "kind",
      "source",
      "session_id",
      "user_id",
      "snapshot_verified_at",
      "bucket_start",
      "hour_start",
      "model",
      "started_at",
      "ended_at",
    ])
      if (safeText(row[k], 500)) out[k] = safeText(row[k], 500);
    Object.assign(out, numbers(row, COUNTS));
    // Account states use a nested usage payload in upstream versions.
    for (const k of ["usage", "usage_buckets", "buckets"])
      if (row[k] && typeof row[k] === "object") out[k] = numericTree(row[k]);
    return out;
  }
  return {
    source: safeText(row.source),
    model: safeText(row.model),
    hour_start: safeText(row.hour_start),
    ...numbers(row, [
      ...COUNTS,
      ...Object.keys(row).filter((k) =>
        /^(priority|long_context|ultrafast)_.*tokens$/.test(k),
      ),
    ]),
    ...(safeText(row.fork_price_version)
      ? { fork_price_version: safeText(row.fork_price_version) }
      : {}),
    ...(safeText(row.fork_price_observed_at)
      ? { fork_price_observed_at: safeText(row.fork_price_observed_at) }
      : {}),
    ...(safeText(row.usage_precision)
      ? { usage_precision: safeText(row.usage_precision) }
      : {}),
    device,
  };
}
function numericTree(value) {
  if (Array.isArray(value)) return value.map(numericTree);
  if (!value || typeof value !== "object")
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (["selected_models", "reroute_reasons"].includes(k) && Array.isArray(v))
      out[k] = v.map((x) => safeText(x)).filter(Boolean);
    else if (
      /token|duration|count|cost|_ms$|percent|turn/.test(k) &&
      typeof v === "number" &&
      Number.isFinite(v) &&
      v >= 0
    )
      out[k] = v;
    else if (
      ["model", "hour_start", "day", "date", "source", "pricing_tier"].includes(
        k,
      ) &&
      safeText(v)
    )
      out[k] = safeText(v);
    else if (
      v &&
      typeof v === "object" &&
      [
        "tokens",
        "model_usage",
        "usage_buckets",
        "performance",
        "usage",
        "buckets",
      ].includes(k)
    )
      out[k] = numericTree(v);
  }
  return out;
}
function session(row, device, { syncTitles = true } = {}) {
  const out = {
    device,
    project_key: row.fork_project_key || projectIdentity(row, device),
    ...numbers(row, SESSION_NUMBERS),
  };
  for (const k of [
    "session_hash",
    "session_id",
    "parent_session_id",
    "forked_from_id",
    "source",
    "model",
    "started_at",
    "ended_at",
    "cost_source",
    "usage_precision",
  ])
    if (safeText(row[k], 500)) out[k] = safeText(row[k], 500);
  for (const k of [
    "cost_is_partial",
    "productive",
    "first_pass",
    "one_shot",
    "usage_is_incomplete",
  ])
    if (typeof row[k] === "boolean") out[k] = row[k];
  for (const k of ["tokens", "model_usage", "usage_buckets", "performance"])
    if (row[k] && typeof row[k] === "object") out[k] = numericTree(row[k]);
  if (syncTitles && safeText(row.title, 200))
    out.title = safeText(row.title, 200);
  return out;
}
function project(row, device) {
  return {
    ...bucket(row, device),
    project_key: projectIdentity(row, device),
    project_ref:
      safeText(row.project_ref, 1000) && /^https:\/\//.test(row.project_ref)
        ? row.project_ref
        : null,
    project_name: safeText(row.project_name || row.project_key, 120),
  };
}
module.exports = {
  bucket,
  project,
  session,
  projectIdentity,
  safeText,
  numbers,
  numericTree,
  COUNTS,
};
