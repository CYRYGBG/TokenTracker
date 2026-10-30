// Calendar arithmetic uses UTC day keys after the caller resolves its timezone.
// This avoids 23/25-hour DST days shifting a report's boundaries.
const date = (key) => new Date(`${key}T00:00:00Z`);
const key = (d) => d.toISOString().slice(0, 10);
const shift = (day, n) => {
  const d = date(day);
  d.setUTCDate(d.getUTCDate() + n);
  return key(d);
};
const count = (a, b) => Math.round((date(b) - date(a)) / 86400000) + 1;
const monthStart = (day, offset = 0) => {
  const d = date(day);
  return key(
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)),
  );
};

export function reportPeriods(kind, today) {
  const yesterday = shift(today, -1);
  const monday = shift(today, -((date(today).getUTCDay() + 6) % 7));
  return Array.from({ length: kind === "week" ? 27 : 25 }, (_, i) => {
    const from =
      kind === "week" ? shift(monday, -7 * i) : monthStart(today, -i);
    const end =
      kind === "week" ? shift(from, 6) : shift(monthStart(from, 1), -1);
    const to = end < yesterday ? end : yesterday;
    if (to < from) return null;
    const previousFrom =
      kind === "week" ? shift(from, -7) : monthStart(from, -1);
    const previousEnd =
      kind === "week" ? shift(previousFrom, 6) : shift(from, -1);
    const aligned = shift(previousFrom, count(from, to) - 1);
    const previousTo = aligned < previousEnd ? aligned : previousEnd;
    return {
      id: from,
      from,
      to,
      previousFrom,
      previousTo,
      days: count(from, to),
      previousDays: count(previousFrom, previousTo),
      ongoing: to < end,
    };
  })
    .filter(Boolean)
    .slice(0, kind === "week" ? 26 : 24);
}

const num = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0);
export function reportProjectName(entry) {
  const ref = entry.project_ref;
  if (!ref) return null; // Source-only fallback is not a real project.
  try {
    return decodeURIComponent(
      String(ref).split(/[\\/]/).filter(Boolean).at(-1),
    ).replace(/\.git$/, "");
  } catch {
    return (
      String(entry.project_key || "")
        .split("/")
        .at(-1) || null
    );
  }
}

export function buildReport(
  period,
  { summary, previous, daily, breakdown, projects, devices },
) {
  const tokens = num(summary?.totals?.total_tokens);
  const byDay = new Map((daily?.data || []).map((d) => [d.day, d]));
  const days = Array.from({ length: period.days }, (_, i) => {
    const day = shift(period.from, i),
      row = byDay.get(day);
    return {
      day,
      tokens: num(row?.total_tokens),
      cost: num(row?.total_cost_usd),
    };
  });
  const tools = (breakdown?.sources || [])
    .map((s) => ({ name: s.source, tokens: num(s.totals?.total_tokens) }))
    .sort((a, b) => b.tokens - a.tokens);
  const modelTotals = new Map();
  for (const source of breakdown?.sources || [])
    for (const m of source.models || []) {
      const name = m.model_id || m.model;
      modelTotals.set(
        name,
        (modelTotals.get(name) || 0) + num(m.totals?.total_tokens),
      );
    }
  const entries = (projects?.entries || []).filter((p) => reportProjectName(p));
  const ranked = entries
    .map((p) => ({
      id: p.project_key,
      name: reportProjectName(p),
      tokens: num(p.total_tokens),
    }))
    .sort((a, b) => b.tokens - a.tokens);
  const assigned = entries.reduce((sum, p) => sum + num(p.total_tokens), 0);
  const sourceAssigned = new Map();
  for (const p of entries)
    for (const s of p.sources || [])
      sourceAssigned.set(
        s.source,
        (sourceAssigned.get(s.source) || 0) + num(s.total_tokens),
      );
  const deviceRows = [
    ...(devices?.devices || []).map((d) => ({
      id: d.id,
      name: d.device_name,
      platform: d.platform,
      tokens: num(d.total_tokens),
    })),
    ...(devices?.account_sources || []).map((s) => ({
      id: `account-${s.source}`,
      name: s.source,
      account: true,
      tokens: num(s.total_tokens),
    })),
  ];
  const limitedProjects = (projects?.entries?.length || 0) >= 10;
  const incomplete =
    [summary, previous, daily, breakdown, projects, devices].some(
      (r) => r?.partial,
    ) ||
    days.reduce((s, d) => s + d.tokens, 0) !== tokens ||
    tools.reduce((s, d) => s + d.tokens, 0) !== tokens ||
    deviceRows.reduce((s, d) => s + d.tokens, 0) !== tokens ||
    assigned > tokens;
  return {
    ...period,
    tokens,
    cost: num(summary?.totals?.total_cost_usd),
    previousTokens: num(previous?.totals?.total_tokens),
    previousCost: num(previous?.totals?.total_cost_usd),
    days,
    activeDays: days.filter((d) => d.tokens > 0).length,
    tools,
    projects: ranked,
    limitedProjects,
    unassigned: Math.max(0, tokens - assigned),
    unassignedTools: tools
      .map((t) => ({
        ...t,
        tokens: Math.max(0, t.tokens - (sourceAssigned.get(t.name) || 0)),
      }))
      .filter((t) => t.tokens > 0),
    models: [...modelTotals]
      .map(([name, tokens]) => ({ name, tokens }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5),
    devices: deviceRows,
    incomplete,
  };
}
