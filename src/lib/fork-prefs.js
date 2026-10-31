// Small metadata events use Lamport order + device/id tie break, never wall time.
const path = require("node:path");
const crypto = require("node:crypto");
const store = require("./fork-store");
const { safeText } = require("./sync-store/privacy");
const ACTIONS = new Set([
  "hide",
  "unhide",
  "project_alias_add",
  "project_alias_remove",
  "custom_price_set",
  "custom_price_remove",
  "expense_set",
  "expense_remove",
]);
function validateEvent(e) {
  if (
    !e ||
    !ACTIONS.has(e.action) ||
    !safeText(e.target, 500) ||
    !/^[\w-]+$/.test(e.device || "") ||
    !/^[\w-]+$/.test(e.id || "") ||
    !Number.isSafeInteger(e.seq) ||
    e.seq < 1
  )
    throw new Error("invalid preference event");
  const p = e.payload || {};
  if (e.action === "project_alias_add" && !safeText(p.alias_to, 500))
    throw new Error("invalid project alias");
  if (e.action === "custom_price_set") {
    if (!safeText(p.source, 120) || !safeText(p.model, 150))
      throw new Error("price requires source and model");
    for (const k of ["input", "output", "cache_read", "cache_write"])
      if (typeof p[k] !== "number" || !Number.isFinite(p[k]) || p[k] < 0)
        throw new Error("invalid price");
    if (e.target !== `${p.source}:${p.model}`)
      throw new Error("price target mismatch");
  }
  if (e.action === "expense_set") {
    if (
      !["subscription", "api_consumption", "topup"].includes(p.kind) ||
      !Number.isFinite(p.amount) ||
      p.amount < 0 ||
      p.amount > 1e9 ||
      !/^[A-Z]{3}$/.test(p.currency || "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(p.date || "") ||
      !safeText(p.provider, 120)
    )
      throw new Error("invalid expense");
    for (const k of ["note", "period_start", "period_end"])
      if (p[k] && !safeText(p[k], 300))
        throw new Error("invalid expense metadata");
  }
  return e;
}
function sanitize(e) {
  validateEvent(e);
  const allowed =
    e.action === "expense_set"
      ? [
          "kind",
          "amount",
          "currency",
          "date",
          "provider",
          "period_start",
          "period_end",
          "note",
        ]
      : e.action === "custom_price_set"
        ? ["source", "model", "input", "output", "cache_read", "cache_write"]
        : e.action === "project_alias_add"
          ? ["alias_to"]
          : [];
  return {
    id: e.id,
    device: e.device,
    seq: e.seq,
    action: e.action,
    target: e.target,
    payload: Object.fromEntries(
      allowed
        .filter((k) => e.payload?.[k] != null)
        .map((k) => [k, e.payload[k]]),
    ),
  };
}
function resolve(events) {
  const map = new Map();
  for (const e of events) {
    const clean = sanitize(e);
    const family = e.action.startsWith("project_alias")
      ? "alias"
      : e.action.startsWith("custom_price")
        ? "price"
        : e.action.startsWith("expense")
          ? "expense"
          : "hidden";
    const key = `${family}:${e.target}`;
    const prior = map.get(key);
    if (
      !prior ||
      e.seq > prior.seq ||
      (e.seq === prior.seq &&
        `${e.device}:${e.id}` > `${prior.device}:${prior.id}`)
    )
      map.set(key, clean);
  }
  const values = [...map.values()];
  const spending = new Map(),
    topups = new Map();
  for (const e of values.filter((e) => e.action === "expense_set")) {
    const p = e.payload;
    const map = p.kind === "topup" ? topups : spending;
    map.set(
      p.currency,
      (map.get(p.currency) || 0n) +
        BigInt(p.amount.toFixed(6).replace(".", "")),
    );
  }
  const amounts = (map) =>
    Object.fromEntries(
      [...map].map(([currency, n]) => [
        currency,
        `${n / 1000000n}.${String(n % 1000000n).padStart(6, "0")}`.replace(
          /\.?0+$/,
          "",
        ),
      ]),
    );
  return {
    spending_by_currency: amounts(spending),
    topups_by_currency: amounts(topups),
    events: values,
    hidden: values.filter((e) => e.action === "hide").map((e) => e.target),
    aliases: Object.fromEntries(
      values
        .filter((e) => e.action === "project_alias_add")
        .map((e) => [e.target, e.payload.alias_to]),
    ),
    prices: values
      .filter((e) => e.action === "custom_price_set")
      .map((e) => e.payload),
    expenses: values
      .filter((e) => e.action === "expense_set")
      .map((e) => ({ id: e.target, ...e.payload })),
  };
}
async function local(trackerDir) {
  const saved = await store.read(path.join(trackerDir, "fork-prefs.json"), []);
  const recovered = await store.read(
    path.join(trackerDir, "fork-history", "wire-prefs.json"),
    [],
  );
  return [...new Map([...recovered, ...saved].map((e) => [e.id, e])).values()];
}
async function append(trackerDir, device, input, remoteEvents = []) {
  const file = path.join(trackerDir, "fork-prefs.json");
  return store.serial(file, () =>
    // The event seq is derived from the stored events; the read and the
    // commit must stay inside one cross-process lock or two writers can
    // assign the same seq and one event is lost.
    store.withTransaction([file], async () => {
      const own = await local(trackerDir);
      const seq =
        Math.max(0, ...own.map((e) => e.seq), ...remoteEvents.map((e) => e.seq)) +
        1;
      const event = sanitize({ id: crypto.randomUUID(), device, seq, ...input });
      await store.write(file, [...own, event]);
      return event;
    }),
  );
}
function alias(key, aliases) {
  const seen = new Set();
  while (
    Object.hasOwn(aliases, key) &&
    typeof aliases[key] === "string" &&
    aliases[key] &&
    !seen.has(key)
  ) {
    seen.add(key);
    key = aliases[key];
  }
  return key;
}
module.exports = { validateEvent, sanitize, resolve, local, append, alias };
