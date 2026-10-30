import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  CalendarDays,
  CircleDollarSign,
  ChevronRight,
  Laptop,
  Monitor,
  RefreshCw,
} from "lucide-react";
import { Card } from "../ui/components/Card.jsx";
import { Button } from "../ui/components/Button.jsx";
import { copy } from "../lib/copy";
import { useLocale } from "../hooks/useLocale";
import { useCurrency } from "../hooks/useCurrency";
import { useTokenFormat } from "../hooks/useTokenFormat";
import { formatUsdCurrency } from "../lib/format";
import { getBrowserTimeZone, getLocalDayKey } from "../lib/timezone";
import { reportPeriods } from "../lib/fork-reports";
import { useForkReport } from "../hooks/use-fork-report";

const muted = "text-oai-gray-500 dark:text-oai-gray-400";
const short = (day) => day.slice(5).replace("-", "/");
const share = (n, total) =>
  `${(total > 0 ? (n / total) * 100 : 0).toFixed(1)}%`;
const toolName = (name) =>
  ({
    codex: "Codex",
    zcode: "ZCode",
    dsh: "DeepSeek Harness",
    claude: "Claude Code",
  })[name] || name;
const color = (name) =>
  ({
    codex: "bg-oai-blue",
    zcode: "bg-teal-500",
    dsh: "bg-indigo-400",
    claude: "bg-orange-400",
  })[name] || "bg-oai-gray-400";

function DailyChart({ days, formatTokens, money }) {
  const ref = useRef(null),
    [width, setWidth] = useState(360);
  useEffect(() => {
    const measure = () =>
      setWidth(Math.max(180, ref.current?.clientWidth || 360));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const height = 208,
    left = 48,
    right = 16,
    top = 24,
    bottom = 28,
    maximum = Math.max(1, ...days.map((d) => d.tokens)),
    ceiling = maximum * 1.12;
  const x = (i) =>
      left +
      (days.length === 1
        ? (width - left - right) / 2
        : (i / (days.length - 1)) * (width - left - right)),
    y = (n) => top + (height - top - bottom) * (1 - n / ceiling);
  const path = days
    .map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.tokens)}`)
    .join(" ");
  const ticks = [
    ...new Set([
      0,
      Math.round((days.length - 1) / 3),
      Math.round(((days.length - 1) * 2) / 3),
      days.length - 1,
    ]),
  ];
  const peak = days.reduce((best, d, i) => {
    return d.tokens > days[best].tokens ? i : best;
  }, 0);
  return (
    <div ref={ref} className="w-full min-w-0">
      <svg
        className="block w-full"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={copy("reports.daily")}
      >
        {[0, ceiling / 2, ceiling].map((n) => (
          <g key={n}>
            <line
              x1={left}
              x2={width - right}
              y1={y(n)}
              y2={y(n)}
              className="stroke-oai-gray-200 dark:stroke-oai-gray-800"
            />
            <text
              x={left - 8}
              y={y(n) + 4}
              textAnchor="end"
              className="fill-oai-gray-500 text-[11px]"
            >
              {formatTokens(n)}
            </text>
          </g>
        ))}
        <path
          d={`${path} L${x(days.length - 1)},${height - bottom} L${x(0)},${height - bottom} Z`}
          className="fill-oai-blue/5"
        />
        <path
          d={path}
          fill="none"
          className="stroke-oai-blue"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {ticks.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={height - 6}
            textAnchor={
              i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"
            }
            className="fill-oai-gray-500 text-[11px]"
          >
            {short(days[i].day)}
          </text>
        ))}
        {days.map((d, i) => (
          <circle
            key={d.day}
            cx={x(i)}
            cy={y(d.tokens)}
            r={i === peak ? 4 : 2}
            className="fill-oai-blue"
          >
            <title>{`${d.day} · ${formatTokens(d.tokens)} · ${money(d.cost)}`}</title>
          </circle>
        ))}
        {Boolean(days[peak].tokens) && (
          <text
            x={x(peak)}
            y={y(days[peak].tokens) - 10}
            textAnchor={
              ["start", "middle", "end"][Math.round((x(peak) / width) * 2)]
            }
            className="fill-oai-gray-800 dark:fill-oai-gray-200 text-[11px]"
          >
            {formatTokens(days[peak].tokens)}
          </text>
        )}
      </svg>
    </div>
  );
}

export function ReportsPage() {
  const { resolvedLocale } = useLocale();
  const { currency, rate } = useCurrency();
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const [kind, setKind] = useState("month"),
    [picked, setPicked] = useState({}),
    [refreshKey, setRefreshKey] = useState(0),
    [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);
  const timeZone = getBrowserTimeZone(),
    today = getLocalDayKey({ timeZone, date: now });
  const periods = useMemo(() => reportPeriods(kind, today), [kind, today]);
  const period = periods.find((p) => p.id === picked[kind]) || periods[0];
  const { data, error, loading } = useForkReport(period, timeZone, refreshKey);
  const money = (n) => formatUsdCurrency(n, { currency, rate });
  const dateLabel = (day) =>
    new Intl.DateTimeFormat(resolvedLocale, {
      year: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(`${day}T00:00:00Z`));
  const optionLabel = (p) =>
    (kind === "month" ? dateLabel(p.from) : `${p.from}–${short(p.to)}`) +
    (p.ongoing ? ` · ${copy("reports.until", { date: short(p.to) })}` : "");
  const comparison = copy(
    kind === "week" ? "reports.vs_week" : "reports.vs_month",
  );
  const delta = (n, prior, cost = false) =>
    data?.incomplete
      ? copy("reports.unavailable")
      : prior > 0
        ? `${n >= prior ? "↑" : "↓"} ${Math.abs((n / prior - 1) * 100).toFixed(1)}% · ${n >= prior ? "+" : "−"}${cost ? money(Math.abs(n - prior)) : formatTokens(Math.abs(n - prior))}`
        : copy("reports.no_previous");
  const row = (name, n, barClass = "bg-oai-blue", id = name) => {
    return (
      <div key={id} className="py-2.5 min-w-0">
        <div className="flex justify-between items-center gap-3 text-xs mb-2">
          <span className="truncate" title={name}>
            {name}
          </span>
          <span
            className="flex shrink-0 gap-3 tabular-nums"
            title={formatTokensTooltip(n)}
          >
            {formatTokens(n)}
            <span className={muted}>{share(n, data.tokens)}</span>
          </span>
        </div>
        <div className="h-1 rounded-full bg-oai-gray-100 dark:bg-oai-gray-800 overflow-hidden">
          <div
            className={`h-full rounded-full ${barClass}`}
            style={{
              width: `${Math.min(100, data.tokens > 0 ? (n / data.tokens) * 100 : 0)}%`,
            }}
          />
        </div>
      </div>
    );
  };
  return (
    <div className="flex flex-col flex-1 min-w-0">
      <main className="w-full max-w-7xl mx-auto px-4 py-6 md:px-6 lg:px-8">
        <div className="flex flex-wrap justify-between items-center gap-4 mb-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {copy("reports.title")}
            </h1>
            <p className={`text-xs mt-1 ${muted}`}>
              {kind === "month"
                ? dateLabel(period.from)
                : `${period.from}–${short(period.to)}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div
              role="tablist"
              aria-label={copy("reports.period")}
              className="flex gap-1 rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 p-1"
            >
              {["week", "month"].map((k) => (
                <Button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={k === kind}
                  aria-controls="report-content"
                  id={`report-${k}`}
                  variant={k === kind ? "primary" : "ghost"}
                  size="sm"
                  onClick={() => setKind(k)}
                >
                  {copy(k === "week" ? "reports.week" : "reports.month")}
                </Button>
              ))}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-label={copy("reports.refresh")}
              onClick={() => {
                setNow(new Date());
                setRefreshKey((k) => k + 1);
              }}
              disabled={loading}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 items-center mb-3">
          <label htmlFor="report-date" className={`text-xs ${muted}`}>
            {copy("reports.date")}
          </label>
          <select
            id="report-date"
            className="max-w-full text-xs rounded-md border border-oai-gray-200 dark:border-oai-gray-700 bg-white dark:bg-oai-gray-900 px-3 py-2"
            value={period.id}
            onChange={(e) =>
              setPicked((p) => ({ ...p, [kind]: e.target.value }))
            }
          >
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {optionLabel(p)}
              </option>
            ))}
          </select>
        </div>
        <p className={`text-xs mb-5 ${muted}`}>
          {copy("reports.compare_range", {
            from: period.from,
            to: period.to,
            previousFrom: period.previousFrom,
            previousTo: period.previousTo,
          })}
          {period.days === period.previousDays
            ? ` · ${copy("reports.same_days", { days: period.days })}`
            : ""}
        </p>
        <section
          id="report-content"
          role="tabpanel"
          aria-labelledby={`report-${kind}`}
          aria-busy={loading}
        >
          {loading && (
            <p role="status" className={`py-8 text-sm ${muted}`}>
              {copy("fork.personal.300ee3dee4")}
            </p>
          )}
          {error && (
            <p role="alert" className="py-4 text-sm text-red-600">
              {copy("reports.failed")} {error}
            </p>
          )}
          {data && (
            <>
              <div aria-live="polite">
                {data.incomplete && (
                  <p
                    role="alert"
                    className="text-sm mb-4 text-amber-700 dark:text-amber-400"
                  >
                    {copy("reports.incomplete")}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
                {[
                  [
                    copy("reports.tokens"),
                    formatTokens(data.tokens),
                    delta(data.tokens, data.previousTokens),
                    comparison,
                    BarChart3,
                  ],
                  [
                    copy("reports.cost", { currency }),
                    money(data.cost),
                    delta(data.cost, data.previousCost, true),
                    comparison,
                    CircleDollarSign,
                  ],
                  [
                    copy("reports.active"),
                    copy("reports.active_value", {
                      active: data.activeDays,
                      days: period.days,
                    }),
                    copy("reports.average", {
                      tokens: formatTokens(data.tokens / period.days),
                    }),
                    "",
                    CalendarDays,
                  ],
                ].map(([label, value, context, sub, Icon]) => (
                  <Card key={label} bodyClassName="!p-4">
                    <div
                      className={`flex justify-between items-center text-xs ${muted}`}
                    >
                      {label}
                      <Icon className="h-4 w-4" />
                    </div>
                    <div
                      className="text-3xl font-semibold tracking-tight tabular-nums break-words my-2"
                      title={
                        label === copy("reports.tokens")
                          ? formatTokensTooltip(data.tokens)
                          : undefined
                      }
                    >
                      {value}
                    </div>
                    <div className={`text-xs tabular-nums ${muted}`}>
                      {context}
                    </div>
                    {sub && (
                      <div className={`text-xs mt-1 ${muted}`}>{sub}</div>
                    )}
                  </Card>
                ))}
              </div>
              {!data.tokens && (
                <p className={`text-sm mb-4 ${muted}`}>
                  {copy("reports.empty")}
                </p>
              )}
              <div className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] gap-4 items-start">
                <Card className="min-w-0" title={copy("reports.daily")}>
                  <DailyChart
                    days={data.days}
                    formatTokens={formatTokens}
                    money={money}
                  />
                  {Boolean(data.tokens) && (
                    <p
                      className={`text-xs border-t border-oai-gray-200 dark:border-oai-gray-800 pt-3 mt-3 ${muted}`}
                    >
                      {(() => {
                        const peak = data.days.reduce((a, b) =>
                          a.tokens > b.tokens ? a : b,
                        );
                        return copy("reports.peak", {
                          date: short(peak.day),
                          tokens: formatTokens(peak.tokens),
                          share: share(peak.tokens, data.tokens),
                        });
                      })()}
                    </p>
                  )}
                </Card>
                <Card className="min-w-0" title={copy("reports.projects")}>
                  <div className="divide-y divide-oai-gray-200 dark:divide-oai-gray-800">
                    {data.projects
                      .slice(0, 4)
                      .map((p) => row(p.name, p.tokens, "bg-oai-blue", p.id))}
                    {data.projects.length > 4 &&
                      row(
                        copy("reports.other_projects"),
                        data.projects
                          .slice(4)
                          .reduce((s, p) => s + p.tokens, 0),
                      )}
                    {Boolean(data.unassigned) &&
                      row(
                        copy(
                          data.limitedProjects
                            ? "reports.other_unassigned"
                            : "reports.unassigned",
                        ),
                        data.unassigned,
                        "bg-oai-gray-400/60",
                      )}
                  </div>
                  {Boolean(data.unassigned) && (
                    <details className="border-t border-oai-gray-200 dark:border-oai-gray-800 mt-3 pt-3 group">
                      <summary
                        className={`flex items-center gap-1 text-xs cursor-pointer ${muted}`}
                      >
                        <ChevronRight className="h-3.5 w-3.5 group-open:rotate-90" />
                        {copy("reports.unassigned_title")}
                      </summary>
                      <p className={`text-xs leading-relaxed mt-3 ${muted}`}>
                        {copy(
                          data.limitedProjects
                            ? "reports.unassigned_limited_help"
                            : "reports.unassigned_help",
                        )}
                      </p>
                      {data.unassignedTools.map((t) => (
                        <div
                          key={t.name}
                          className={`flex justify-between text-xs mt-2 ${muted}`}
                        >
                          <span>{toolName(t.name)}</span>
                          <span className="tabular-nums">
                            {formatTokens(t.tokens)}
                          </span>
                        </div>
                      ))}
                    </details>
                  )}
                </Card>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start mt-4">
                <Card className="min-w-0" title={copy("reports.tools")}>
                  <div
                    role="img"
                    aria-label={copy("reports.tools")}
                    className="flex h-2 rounded-full overflow-hidden gap-0.5 bg-oai-gray-100 dark:bg-oai-gray-800 mb-3"
                  >
                    {data.tools.map((t) => (
                      <div
                        key={t.name}
                        className={color(t.name)}
                        style={{
                          width: `${data.tokens ? (t.tokens / data.tokens) * 100 : 0}%`,
                        }}
                      />
                    ))}
                  </div>
                  {data.tools.map((t) => (
                    <div
                      key={t.name}
                      className="flex justify-between gap-3 py-2 text-xs"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-sm ${color(t.name)}`}
                        />
                        <span className="truncate">{toolName(t.name)}</span>
                      </span>
                      <span className="flex gap-3 tabular-nums shrink-0">
                        {formatTokens(t.tokens)}
                        <span className={muted}>
                          {share(t.tokens, data.tokens)}
                        </span>
                      </span>
                    </div>
                  ))}
                </Card>
                <Card className="min-w-0" title={copy("reports.devices")}>
                  <div className="divide-y divide-oai-gray-200 dark:divide-oai-gray-800">
                    {data.devices.map((d) => (
                      <div key={d.id} className="flex items-start gap-2">
                        <span className={`pt-2.5 ${muted}`}>
                          {d.platform === "darwin" ? (
                            <Laptop className="h-4 w-4" />
                          ) : (
                            <Monitor className="h-4 w-4" />
                          )}
                        </span>
                        <div className="flex-1 min-w-0">
                          {row(
                            d.account
                              ? copy("reports.account", {
                                  source: toolName(d.name),
                                })
                              : d.name,
                            d.tokens,
                            "bg-oai-gray-500",
                            d.id,
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
              <details className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 mt-4 group">
                <summary className="flex justify-between items-center gap-3 p-4 cursor-pointer text-xs">
                  <span className="flex gap-2 items-center">
                    <ChevronRight className="h-4 w-4 group-open:rotate-90" />
                    {copy("reports.models")}
                  </span>
                  <span className={muted}>{copy("reports.top_five")}</span>
                </summary>
                <div className="px-5 pb-4 divide-y divide-oai-gray-200 dark:divide-oai-gray-800">
                  {data.models.map((m) => (
                    <div
                      key={m.name}
                      className="flex gap-3 justify-between py-2 text-xs"
                    >
                      <span className="truncate" title={m.name}>
                        {m.name}
                      </span>
                      <span className="flex gap-3 tabular-nums shrink-0">
                        {formatTokens(m.tokens)}
                        <span className={muted}>
                          {share(m.tokens, data.tokens)}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
