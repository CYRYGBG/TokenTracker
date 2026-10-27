const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const durable = require("../src/lib/fork-store"),
  prefs = require("../src/lib/fork-prefs"),
  privacy = require("../src/lib/sync-store/privacy"),
  pricing = require("../src/lib/pricing");
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-fork-meta-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test("live price refresh clears negative matches, keeps source rules scoped and preserves frozen estimates", async (t) => {
  const dir = await temporary(t);
  t.after(() => {
    pricing.setCustomPrices([]);
    pricing.resetPricingForTests();
  });
  const model = "fixture-unlisted-model";
  assert.equal(pricing.getModelPricingInfo(model).status, "unpriced");
  await pricing.reloadPricing({
    cachePath: path.join(dir, "pricing.json"),
    fetchImpl: async () => ({
      [model]: {
        input_cost_per_token: 1 / 1e6,
        output_cost_per_token: 2 / 1e6,
      },
    }),
  });
  assert.equal(pricing.getModelPricing(model).input, 1);
  const version = pricing.getPricingStatus().version;
  const row = {
    source: "codex",
    model,
    hour_start: "2026-10-25T10:00:00Z",
    input_tokens: 1e6,
    output_tokens: 0,
    total_tokens: 1e6,
  };
  const costs = require("../src/lib/fork-costs");
  const frozen = await costs.capture(dir, [row]);
  assert.equal(pricing.computeRowCost(frozen[0]), 1);
  await pricing.reloadPricing({
    cachePath: path.join(dir, "pricing.json"),
    fetchImpl: async () => ({
      [model]: {
        input_cost_per_token: 3 / 1e6,
        output_cost_per_token: 4 / 1e6,
      },
    }),
  });
  assert.equal(pricing.getModelPricing(model).input, 3);
  assert.notEqual(pricing.getPricingStatus().version, version);
  assert.equal(pricing.computeRowCost((await costs.capture(dir, [row]))[0]), 1);
  const imported =
    require("../src/lib/sync-store/importer").mergeBucketsAcrossDevices({
      localRows: [{ ...row, device: "local", fork_estimated_cost_usd: 3 }],
      remoteDevices: [
        {
          machineId: "peer",
          rows: [{ ...row, device: "peer", fork_estimated_cost_usd: 1 }],
        },
      ],
    });
  assert.equal(
    pricing.computeRowCost(imported[0]),
    4,
    "merged estimate includes both devices at their observed price bases",
  );
  const revised = await costs.capture(dir, [row], { reestimate: true });
  assert.equal(pricing.computeRowCost(revised[0]), 3);
  pricing.setCustomPrices([
    {
      source: "zcode",
      model,
      input: 7,
      output: 8,
      cache_read: 0,
      cache_write: 0,
    },
  ]);
  assert.equal(pricing.getModelPricing(model, { source: "zcode" }).input, 7);
  assert.equal(pricing.getModelPricing(model, { source: "codex" }).input, 3);
  assert.equal(pricing.getModelPricingInfo("still-unknown").status, "unpriced");
  pricing.setCustomPrices([
    {
      source: "zcode",
      model,
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    },
  ]);
  assert.equal(
    pricing.getModelPricingInfo(model, { source: "zcode" }).status,
    "free",
  );
});
test("offline pricing refresh falls back to cache in the same process", async (t) => {
  const dir = await temporary(t);
  t.after(() => pricing.resetPricingForTests());
  const cache = path.join(dir, "pricing.json");
  await pricing.reloadPricing({
    cachePath: cache,
    fetchImpl: async () => ({
      "fixture-model": { input_cost_per_token: 2e-6 },
    }),
  });
  await pricing.reloadPricing({
    cachePath: cache,
    fetchImpl: async () => {
      throw Error("offline");
    },
  });
  assert.equal(pricing.getModelPricing("fixture-model").input, 2);
  assert.equal(pricing.getPricingStatus().source, "stale-cache");
});
test("Lamport preference events converge without wall clocks, edits preserve one payment and aliases split", async (t) => {
  const dir = await temporary(t);
  const a = await prefs.append(
    dir,
    "machine-aaaa",
    { action: "hide", target: "session-1" },
    [],
  );
  const b = {
    id: "event-b",
    device: "machine-bbbb",
    seq: 2,
    action: "unhide",
    target: "session-1",
    payload: {},
  };
  assert.deepEqual(prefs.resolve([b, a]).hidden, []);
  const e = await prefs.append(
    dir,
    "machine-aaaa",
    {
      action: "expense_set",
      target: "payment-1",
      payload: {
        kind: "subscription",
        amount: 20,
        currency: "USD",
        date: "2026-10-25",
        provider: "Codex",
        password: "EXCLUDED",
      },
    },
    [b],
  );
  assert.ok(e.seq > b.seq);
  assert.equal("password" in e.payload, false);
  const edited = {
    ...e,
    id: "event-edit",
    device: "machine-bbbb",
    seq: e.seq + 1,
    payload: { ...e.payload, amount: 22 },
  };
  const state = prefs.resolve([e, edited, e]);
  assert.equal(state.expenses.length, 1);
  assert.equal(state.expenses[0].amount, 22);
  const topup = {
    ...edited,
    id: "topup-event",
    target: "topup-1",
    payload: { ...edited.payload, kind: "topup", amount: 100 },
  };
  assert.equal(prefs.resolve([edited, topup]).spending_by_currency.USD, "22");
  assert.equal(prefs.resolve([edited, topup]).topups_by_currency.USD, "100");
  const alias = await prefs.append(
    dir,
    "machine-aaaa",
    {
      action: "project_alias_add",
      target: "a/repo",
      payload: { alias_to: "b/repo" },
    },
    [edited],
  );
  assert.equal(prefs.alias("a/repo", prefs.resolve([alias]).aliases), "b/repo");
  const split = {
    ...alias,
    id: "event-split",
    seq: alias.seq + 1,
    action: "project_alias_remove",
    payload: {},
  };
  assert.equal(
    prefs.alias("a/repo", prefs.resolve([split, alias]).aliases),
    "a/repo",
  );
});
test("atomic persistence failure keeps previous history readable", async (t) => {
  const dir = await temporary(t),
    file = path.join(dir, "history.json");
  await durable.write(file, { tokens: 100 });
  const rename = fs.rename;
  try {
    fs.rename = async () => {
      throw Object.assign(Error("fixture write failure"), { code: "EIO" });
    };
    await assert.rejects(durable.write(file, { tokens: 0 }), /write failure/);
  } finally {
    fs.rename = rename;
  }
  assert.deepEqual(await durable.read(file, null), { tokens: 100 });
});
test("wire schema excludes nested content and paths, preserves distinct project identity and exact token categories", () => {
  const row = {
    session_hash: "s1",
    source: "dsh",
    project_ref: "/tmp/private/project",
    project_key: "same-name",
    model: "deepseek-v4-flash",
    title: "fix /tmp/private/project",
    tokens: {
      input_tokens: 10,
      cached_input_tokens: 20,
      reasoning_output_tokens: 3,
      prompt: "SECRET",
    },
    model_usage: [
      { model: "deepseek-v4-flash", input_tokens: 10, authorization: "SECRET" },
    ],
    prompt: "SECRET",
    resume_command: "SECRET",
  };
  const wire = privacy.session(row, "machine-aaaa");
  const text = JSON.stringify(wire);
  for (const value of ["SECRET", "/tmp/private", "resume_command"])
    assert.ok(!text.includes(value));
  assert.equal(wire.tokens.reasoning_output_tokens, 3);
  assert.notEqual(
    privacy.projectIdentity(row, "machine-aaaa"),
    privacy.projectIdentity(row, "machine-bbbb"),
  );
  assert.equal(
    privacy.projectIdentity(
      { project_ref: "git@github.com:acme/repo.git" },
      "a",
    ),
    privacy.projectIdentity(
      { project_ref: "https://github.com/acme/repo" },
      "b",
    ),
  );
  assert.notEqual(
    privacy.projectIdentity(
      { project_ref: "https://github.com/acme/repo" },
      "a",
    ),
    privacy.projectIdentity(
      { project_ref: "https://gitlab.com/acme/repo" },
      "b",
    ),
  );
});
test("Harness session adapter reuses upstream categories and retains deleted sources across rescans", async (t) => {
  const home = await temporary(t),
    tracker = path.join(home, ".tokentracker", "tracker"),
    source = path.join(home, ".dsh", "sessions", "project", "session-1");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(tracker, { recursive: true });
  await fs.writeFile(
    path.join(tracker, "config.json"),
    JSON.stringify({ machineId: "machine-dsh-aaaa" }),
  );
  const events = [
    { type: "session", id: "session-1" },
    {
      type: "request/header",
      seq: 1,
      data: { header: { config: { model: "deepseek/deepseek-v4-flash" } } },
    },
    {
      type: "assistant/message",
      seq: 2,
      time: Date.parse("2026-10-25T10:00:00Z"),
      data: {
        message: { source: { model: "deepseek/deepseek-v4-flash" } },
        usage: {
          inputTokens: 10,
          cacheReadTokens: 20,
          outputTokens: 5,
          reasoningTokens: 3,
        },
      },
    },
  ];
  await fs.writeFile(
    path.join(source, "session.jsonl"),
    events.map(JSON.stringify).join("\n") + "\n",
  );
  const view = require("../src/lib/fork-view");
  const first = await view.collectSessions(tracker, { home, force: true });
  assert.equal(first.length, 1);
  assert.equal(first[0].source, "dsh");
  assert.equal(first[0].total_tokens, 38);
  assert.equal(first[0].tokens.input_tokens, 10);
  assert.equal(first[0].tokens.cached_input_tokens, 20);
  const second = await view.collectSessions(tracker, { home, force: true });
  assert.equal(second[0].total_tokens, 38);
  await fs.rm(source, { recursive: true });
  const third = await view.collectSessions(tracker, { home, force: true });
  assert.equal(third[0].total_tokens, 38);
  // Recover a corrected record with the same total from this device's remote
  // snapshot. A stale local backup must not replace its model or price basis.
  const raw = third.map((row) => privacy.session(row, "machine-dsh-aaaa"));
  const corrected = { ...raw[0], model: "corrected-model", cost_usd: 0.75 };
  await durable.write(
    path.join(tracker, "fork-history", "wire-sessions.json"),
    [corrected],
  );
  await durable.write(path.join(tracker, "webdav", "state.json"), {
    input_hashes: {
      sessions: require("../src/lib/sync-store/exporter").stableRowsHash(raw),
    },
  });
  const recovered = await view.sessions(tracker, new URL("http://localhost"), {
    home,
    scan: false,
  });
  assert.equal(recovered[0].model, "corrected-model");
  assert.equal(recovered[0].cost_usd, 0.75);
  assert.equal(recovered[0].restored, true);
});
