// Snapshot the first observed estimate for each cumulative ledger record.
// A changed usage record gets a fresh basis; price refresh alone does not.
const path = require("node:path");
const crypto = require("node:crypto");
const durable = require("./fork-store");
const caches = new Map();
async function capture(trackerDir, rows, { reestimate = false } = {}) {
  const cached = caches.get(trackerDir);
  if (!reestimate && cached?.rows === rows) return cached.result;
  const file = path.join(trackerDir, "fork-cost-basis.json");
  return durable.serial(file, async () => {
    const pricing = require("./pricing");
    const basis = await durable.read(file, {});
    let changed = false;
    const result = rows.map((row) => {
      if (row.kind) return row;
      if (!reestimate && Number.isFinite(row.fork_estimated_cost_usd))
        return row;
      const key = `${row.device || "local"}|${row.source}|${row.model}|${row.hour_start}`;
      const raw = { ...row };
      delete raw.fork_estimated_cost_usd;
      delete raw.fork_price_version;
      delete raw.fork_price_observed_at;
      const signature = crypto
        .createHash("sha256")
        .update(JSON.stringify(raw))
        .digest("hex");
      if (reestimate || !basis[key] || basis[key].signature !== signature) {
        basis[key] = {
          signature,
          cost: pricing.computeRowCost(raw),
          version: pricing.getPricingStatus().version,
          at: new Date().toISOString(),
        };
        changed = true;
      }
      return {
        ...row,
        fork_estimated_cost_usd: basis[key].cost,
        fork_price_version: basis[key].version,
        fork_price_observed_at: basis[key].at,
      };
    });
    if (changed) await durable.write(file, basis);
    caches.set(trackerDir, { rows, result });
    return result;
  });
}
function invalidate(trackerDir) {
  caches.delete(trackerDir);
}
module.exports = { capture, invalidate };
