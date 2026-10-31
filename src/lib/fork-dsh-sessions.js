// Metadata adapter over the upstream Harness decoder and token normalization.
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const durable = require("./fork-store");
function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
}
async function scanDshSessions(home = os.homedir(), { cacheFile, force = false } = {}) {
  const rollout = require("./rollout");
  const { sessionHash } = require("./session-analytics");
  const pricing = require("./pricing");
  const env =
    home === os.homedir()
      ? process.env
      : { ...process.env, TOKENTRACKER_DSH_HOME: path.join(home, ".dsh") };
  const files = await rollout.resolveDshSessionFiles(env);
  const sessions = [];
  let prior = {};
  if (cacheFile) {
    try { prior = await durable.read(cacheFile, {}); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  const cache = { version: 1, files: {} };
  const reprice = (row) => {
    row.model_usage = row.model_usage.map((m) => ({ ...m, cost_usd: pricing.computeRowCost({ ...m, source: "dsh" }) }));
    row.cost_usd = row.model_usage.reduce((sum, m) => sum + m.cost_usd, 0);
    return row;
  };
  for (const file of files) {
    try {
      const key = crypto.createHash("sha256").update(path.resolve(file)).digest("hex");
      const signature = identity(await fs.stat(file, { bigint: true }));
      const saved = prior.version === 1 ? prior.files?.[key] : null;
      if (!force && saved?.signature === signature) {
        cache.files[key] = saved;
        if (saved.row) sessions.push(reprice(structuredClone(saved.row)));
        continue;
      }
      const result = rollout.extractDshSessionUsage(
        await rollout.readDshSessionText(file),
      );
      if (!result.complete) continue;
      const unchanged = signature === identity(await fs.stat(file, { bigint: true }));
      if (!result.deltas.length) {
        if (unchanged) cache.files[key] = { signature, row: null };
        continue;
      }
      const id = result.sessionId || path.basename(path.dirname(file));
      const byModel = new Map(),
        byHour = new Map();
      const tokens = {
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
      };
      for (const d of result.deltas) {
        const m = byModel.get(d.model) || {
          model: d.model,
          ...Object.fromEntries(Object.keys(tokens).map((k) => [k, 0])),
        };
        const hour = new Date(
          Math.floor(d.timeMs / 1800000) * 1800000,
        ).toISOString();
        const key = `${hour}|${d.model}`;
        const bucket = byHour.get(key) || {
          hour_start: hour,
          model: d.model,
          tokens: Object.fromEntries(Object.keys(tokens).map((k) => [k, 0])),
        };
        for (const k of Object.keys(tokens)) {
          tokens[k] += d.totals[k] || 0;
          m[k] += d.totals[k] || 0;
          bucket.tokens[k] += d.totals[k] || 0;
        }
        byModel.set(d.model, m);
        byHour.set(key, bucket);
      }
      const times = result.deltas.map((d) => d.timeMs);
      const modelUsage = [...byModel.values()].map((r) => ({
        ...r,
        cost_usd: pricing.computeRowCost({ ...r, source: "dsh" }),
      }));
      const row = {
        source: "dsh",
        session_id: id,
        session_hash: sessionHash("dsh", id),
        project_key: path.basename(path.dirname(path.dirname(file))),
        project_ref: null,
        model: modelUsage.length === 1 ? modelUsage[0].model : "mixed",
        model_usage: modelUsage,
        usage_buckets: [...byHour.values()],
        tokens,
        total_tokens: tokens.total_tokens,
        cost_usd: modelUsage.reduce((n, r) => n + r.cost_usd, 0),
        cost_source: "model_pricing",
        started_at: new Date(Math.min(...times)).toISOString(),
        ended_at: new Date(Math.max(...times)).toISOString(),
        duration_ms: 0,
        usage_precision: "reported",
        analysis_availability: "usage-only",
      };
      sessions.push(row);
      if (unchanged) cache.files[key] = { signature, row };
    } catch (e) {
      if (e.code === "EACCES" || e.code === "ENOENT") continue;
      throw e;
    }
  }
  if (cacheFile && JSON.stringify(prior) !== JSON.stringify(cache)) await durable.write(cacheFile, cache);
  return sessions;
}
module.exports = { scanDshSessions };
