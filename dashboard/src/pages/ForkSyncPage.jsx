import { saveLocalUsageExport } from "../lib/native-bridge";
import { copy } from "../lib/copy";
import React, { useEffect, useMemo, useState } from "react";
import { forkApi } from "../lib/fork-api";
import { Button } from "../ui/components/Button.jsx";
import {
  SectionCard,
  SETTINGS_INPUT_CLASS,
  SettingsRow,
  ToggleSwitch,
} from "../components/settings/Controls.jsx";
const inputClass = SETTINGS_INPUT_CLASS;

// Presets for the background auto-sync cadence. Minutes below an hour, hours
// above; a saved value outside the presets stays selectable so the form never
// shows a lie about the active config.
const INTERVAL_PRESETS_MINUTES = [5, 15, 30, 60, 120, 360, 720, 1440];

/// Local-time "YYYY-MM-DD HH:mm" — the sync status is a human recall aid, not
/// a log line, so no seconds and no UTC suffix.
function formatSyncMinute(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const p2 = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())} ${p2(date.getHours())}:${p2(date.getMinutes())}`;
}

export default function ForkSyncSection() {
  const [config, setConfig] = useState({
    url: "",
    username: "",
    directory: "tokentracker-fork",
    device_name: "",
    enabled: false,
    sync_titles: true,
    interval_minutes: 5,
  });
  const [loadedConfig, setLoadedConfig] = useState(null);
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [prefs, setPrefs] = useState({ expenses: [], prices: [], aliases: {} });
  const [priceStatus, setPriceStatus] = useState(null);
  const [expense, setExpense] = useState({
    id: "",
    provider: "",
    kind: "subscription",
    amount: "",
    currency: "USD",
    date: new Date().toISOString().slice(0, 10),
    period_start: "",
    period_end: "",
    note: "",
  });
  const [price, setPrice] = useState({
    source: "",
    model: "",
    input: "",
    output: "",
    cache_read: "",
    cache_write: "",
  });
  const [alias, setAlias] = useState({ from: "", to: "" });
  const intervalOptions = useMemo(() => {
    const current = Number(config.interval_minutes) || 5;
    const values = INTERVAL_PRESETS_MINUTES.includes(current)
      ? INTERVAL_PRESETS_MINUTES
      : [...INTERVAL_PRESETS_MINUTES, current].sort((a, b) => a - b);
    return values.map((minutes) => ({
      value: minutes,
      label:
        minutes < 60
          ? `${minutes} ${copy("fork.personal.6f7a8b9c0d")}`
          : `${minutes / 60} ${copy("fork.personal.7b8c9d0e1f")}`,
    }));
  }, [config.interval_minutes]);
  async function load() {
    const [s, p, ps] = await Promise.all([
      forkApi("/api/webdav/status"),
      forkApi("/api/fork/prefs"),
      forkApi("/api/fork/pricing"),
    ]);
    setStatus(s);
    if (s.config) {
      setConfig(s.config);
      setLoadedConfig(s.config);
    }
    setPrefs(p);
    setPriceStatus(ps);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function run(fn, message) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
      setNotice(message);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    await forkApi("/api/webdav/config", {
      method: "PUT",
      body: { ...config, ...(password ? { password } : {}) },
    });
    setPassword("");
  }
  // Selection-type controls (toggles, interval) apply immediately — they are
  // not part of the credential edit flow and need no 编辑 gate.
  const applySelection = (next) => {
    setConfig(next);
    void run(
      () => forkApi("/api/webdav/config", { method: "PUT", body: next }),
      copy("fork.personal.cb84a961b0"),
    );
  };
  const event = (action, target, payload = {}) =>
    forkApi("/api/fork/prefs", {
      method: "POST",
      body: { action, target, payload },
    });
  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <SectionCard title={copy("fork.personal.webdav")}>
        <div className="space-y-4 py-3">
        <p className="text-sm text-oai-gray-500">
          {copy("fork.personal.bfb9248299")}
        </p>
        {/* Credentials are fill-in content: locked rows render as plain text
            until 编辑, so the form never advertises an editability it does
            not have. The password value is never echoed back. */}
        <div className="divide-y divide-oai-gray-200/60 dark:divide-oai-gray-800/60">
          {[
            ["url", copy("fork.personal.86e118291e")],
            ["username", copy("fork.personal.a1aaf352cb")],
            ["directory", copy("fork.personal.663d0b2057")],
            ["device_name", copy("fork.personal.4433eb13be")],
          ].map(([key, label]) => (
            <SettingsRow
              key={key}
              label={
                editing ? (
                  <label htmlFor={`webdav-${key}`}>{label}</label>
                ) : (
                  label
                )
              }
              control={
                editing ? (
                  <input
                    id={`webdav-${key}`}
                    className={inputClass + " sm:w-64"}
                    value={config[key] || ""}
                    onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                  />
                ) : (
                  <span
                    data-testid={`webdav-${key}-value`}
                    className="text-sm break-all text-oai-gray-900 dark:text-oai-gray-200"
                  >
                    {config[key] || copy("fork.personal.63595e95b7")}
                  </span>
                )
              }
            />
          ))}
          <SettingsRow
            label={
              editing ? (
                <label htmlFor="webdav-password">{copy("fork.personal.ae66366412")}</label>
              ) : (
                copy("fork.personal.ae66366412")
              )
            }
            control={
              editing ? (
                <input
                  id="webdav-password"
                  className={inputClass + " sm:w-64"}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  placeholder={status?.credential_present ? copy("fork.personal.8a57844ddf") : copy("fork.personal.63595e95b7")}
                  onChange={(e) => setPassword(e.target.value)}
                />
              ) : (
                <span className="text-sm text-oai-gray-900 dark:text-oai-gray-200">
                  {status?.credential_present
                    ? copy("limits.apiKey.saved")
                    : copy("fork.personal.63595e95b7")}
                </span>
              )
            }
          />
        </div>
        <div className="divide-y divide-oai-gray-200/60 dark:divide-oai-gray-800/60">
          <SettingsRow
            label={copy("fork.personal.5faab6dc38")}
            control={
              <ToggleSwitch
                checked={config.enabled}
                disabled={busy}
                onChange={() =>
                  applySelection({ ...config, enabled: !config.enabled })
                }
                ariaLabel={copy("fork.personal.5faab6dc38")}
              />
            }
          />
          <SettingsRow
            label={<label htmlFor="webdav-interval">{copy("fork.personal.5a6b7c8d9e")}</label>}
            control={
              <select
                id="webdav-interval"
                className={inputClass + " sm:w-40"}
                value={Number(config.interval_minutes) || 5}
                disabled={busy}
                onChange={(e) =>
                  applySelection({ ...config, interval_minutes: Number(e.target.value) })
                }
              >
                {intervalOptions.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            }
          />
          <SettingsRow
            label={copy("fork.personal.0cf7912b4d")}
            control={
              <ToggleSwitch
                checked={config.sync_titles !== false}
                disabled={busy}
                onChange={() =>
                  applySelection({
                    ...config,
                    sync_titles: config.sync_titles === false,
                  })
                }
                ariaLabel={copy("fork.personal.0cf7912b4d")}
              />
            }
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await save();
                    await forkApi("/api/webdav/test", { method: "POST" });
                    setEditing(false);
                  }, copy("fork.personal.eb06635875"))
                }
              >
                {copy("fork.personal.b4a9a5f1b1")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (loadedConfig) setConfig(loadedConfig);
                  setPassword("");
                  setEditing(false);
                }}
              >
                {copy("fork.personal.4c5d6e7f8a")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setNotice("");
                  setEditing(true);
                }}
              >
                {copy("fork.personal.3d7e8f9a0b")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await forkApi("/api/webdav/sync-now", { method: "POST" });
                  }, copy("fork.personal.d9c1fcf2bb"))
                }
              >
                {copy("fork.personal.098d06ecac")}
              </Button>
            </>
          )}
        </div>
        <p className="text-sm">
          {copy("fork.personal.2a0b1ad677")}{" "}
          {formatSyncMinute(status?.sync?.last_success_at) || copy("fork.personal.9ef840e69f")}
        </p>
        {status?.sync?.last_failure ? (
          <p className="text-sm text-red-600">
            {copy("fork.personal.8c9d0e1f2a")}
            {status.sync.last_failure.code ? ` (${status.sync.last_failure.code})` : ""}
          </p>
        ) : null}
        <ul className="text-sm">
          {Object.entries(status?.sync?.imported || {}).map(([id, s]) => (
            <li key={id}>
              {status?.device_names?.[id] || id}：
              {s.ok
                ? copy("fork.personal.76ce8e3d5e")
                : copy("fork.personal.d82674407c")}
            </li>
          ))}
        </ul>
        </div>
      </SectionCard>
      <SectionCard title={copy("fork.personal.bf9c6bfe0c")}>
        <div className="space-y-4 py-3">
        <p className="text-sm">
          {copy("fork.personal.64b3b59a15")}
          {priceStatus?.source || copy("fork.personal.09ceea7644")}
          {copy("fork.personal.294d14b41f")}
          {priceStatus?.version}
          {copy("fork.personal.3cd9c327d8")}
          {priceStatus?.updated_at || copy("fork.personal.d41eaf5289")}
        </p>
        <p className="text-sm">{copy("fork.personal.27b67a62cb")}</p>
        <Button
          variant="secondary"
          size="sm"
                    disabled={busy}
          onClick={() =>
            run(
              () => forkApi("/api/fork/pricing", { method: "POST" }),
              copy("fork.personal.b8f0423455"),
            )
          }
        >
          {copy("fork.personal.4043f74f67")}
        </Button>{" "}
        <Button
          variant="secondary"
          size="sm"
                    disabled={busy}
          onClick={() =>
            run(
              () => forkApi("/api/fork/reestimate", { method: "POST" }),
              copy("fork.personal.336dd82bb0"),
            )
          }
        >
          {copy("fork.personal.25f08768a8")}
        </Button>
        <p className="text-sm">{copy("fork.personal.1b81c2a94d")}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            ["source", copy("fork.personal.0a62e3efba")],
            ["model", copy("fork.personal.2b7c96b260")],
            ["input", copy("fork.personal.e8850440f2")],
            ["output", copy("fork.personal.ded698ae1e")],
            ["cache_read", copy("fork.personal.987b1086b2")],
            ["cache_write", copy("fork.personal.732298044d")],
          ].map(([k, label]) => (
            <label key={k} className="flex min-w-0 flex-col gap-1.5 text-sm">
              {label}
              <input
                className={inputClass}
                type={["source", "model"].includes(k) ? "text" : "number"}
                min="0"
                step="any"
                value={price[k]}
                onChange={(e) => setPrice({ ...price, [k]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <Button
          variant="secondary"
          size="sm"
                    disabled={busy}
          onClick={() =>
            run(
              () =>
                event("custom_price_set", `${price.source}:${price.model}`, {
                  ...price,
                  ...Object.fromEntries(
                    ["input", "output", "cache_read", "cache_write"].map(
                      (k) => [k, Number(price[k])],
                    ),
                  ),
                }),
              copy("fork.personal.a4dafd8a12"),
            )
          }
        >
          {copy("fork.personal.0d0a1ff753")}
        </Button>
        <ul>
          {prefs.prices.map((p) => (
            <li
              className="flex justify-between py-2"
              key={`${p.source}:${p.model}`}
            >
              {p.source} / {p.model}：{p.input} / {p.output}
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  run(
                    () =>
                      event("custom_price_remove", `${p.source}:${p.model}`),
                    copy("fork.personal.4e5c4958dd"),
                  )
                }
              >
                {copy("fork.personal.2f752c005e")}
              </Button>
            </li>
          ))}
        </ul>
        </div>
      </SectionCard>
      <SectionCard title={copy("fork.personal.9fd90671cc")}>
        <div className="space-y-4 py-3">
        <p className="text-sm">{copy("fork.personal.bd744b773b")}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex min-w-0 flex-col gap-1.5 text-sm">
            {copy("fork.personal.e4e46c7235")}
            <select
              className={inputClass}
              value={expense.kind}
              onChange={(e) => setExpense({ ...expense, kind: e.target.value })}
            >
              <option value="subscription">
                {copy("fork.personal.4eb7bf9492")}
              </option>
              <option value="api_consumption">
                {copy("fork.personal.29e25828d2")}
              </option>
              <option value="topup">{copy("fork.personal.fa03c46253")}</option>
            </select>
          </label>
          {[
            ["provider", copy("fork.personal.0c131e3964")],
            ["amount", copy("fork.personal.34943c40c9")],
            ["currency", copy("fork.personal.27f59ac47f")],
            ["date", copy("fork.personal.b6fed9af83")],
            ["period_start", copy("fork.personal.fd322799c8")],
            ["period_end", copy("fork.personal.a74fd5004f")],
            ["note", copy("fork.personal.e0361480e3")],
          ].map(([k, label]) => (
            <label key={k} className="flex min-w-0 flex-col gap-1.5 text-sm">
              {label}
              <input
                className={inputClass}
                type={
                  k.includes("date") || k.includes("period")
                    ? "date"
                    : k === "amount"
                      ? "number"
                      : "text"
                }
                min="0"
                step="any"
                value={expense[k]}
                onChange={(e) =>
                  setExpense({ ...expense, [k]: e.target.value })
                }
              />
            </label>
          ))}
        </div>
        <Button
          variant="secondary"
          size="sm"
                    disabled={busy}
          onClick={() =>
            run(
              () =>
                event("expense_set", expense.id || crypto.randomUUID(), {
                  ...expense,
                  amount: Number(expense.amount),
                }),
              copy("fork.personal.6391fe2841"),
            )
          }
        >
          {expense.id
            ? copy("fork.personal.9ecbb3e7d1")
            : copy("fork.personal.cedf1b25c9")}
        </Button>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400 [&_th]:py-3 [&_th]:font-medium">
              <tr>
                <th>{copy("fork.personal.b6fed9af83")}</th>
                <th>{copy("fork.personal.8e13b2b6b7")}</th>
                <th>{copy("fork.personal.34943c40c9")}</th>
                <th>{copy("fork.personal.f3ea6d345e")}</th>
              </tr>
            </thead>
            <tbody>
              {prefs.expenses.map((e) => (
                <tr
                  className="border-t border-oai-gray-200/70 dark:border-oai-gray-800 [&_td]:py-3"
                  key={e.id}
                >
                  <td>{e.date}</td>
                  <td>
                    {e.provider} /{" "}
                    {copy(
                      e.kind === "subscription"
                        ? "fork.personal.4eb7bf9492"
                        : e.kind === "topup"
                          ? "fork.personal.fa03c46253"
                          : "fork.personal.29e25828d2",
                    )}
                  </td>
                  <td>
                    {e.amount} {e.currency}
                  </td>
                  <td>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="p-2"
            onClick={() => setExpense(e)}
                    >
                      {copy("fork.personal.a7f814c0a4")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="p-2"
            onClick={() =>
                        run(
                          () => event("expense_remove", e.id),
                          copy("fork.personal.35f8fd8c02"),
                        )
                      }
                    >
                      {copy("fork.personal.2f752c005e")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </div>
      </SectionCard>
      <SectionCard title={copy("fork.personal.1b2a661a92")}>
        <div className="space-y-4 py-3">
        <p className="text-sm">{copy("fork.personal.aacf7b101b")}</p>
        <label className="flex min-w-0 flex-col gap-1.5 text-sm">
          {copy("fork.personal.874a561693")}
          <input
            className={inputClass}
            value={alias.from}
            onChange={(e) => setAlias({ ...alias, from: e.target.value })}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-sm">
          {copy("fork.personal.4e4e0570a6")}
          <input
            className={inputClass}
            value={alias.to}
            onChange={(e) => setAlias({ ...alias, to: e.target.value })}
          />
        </label>
        <Button
          variant="secondary"
          size="sm"
                    onClick={() =>
            run(
              () =>
                event("project_alias_add", alias.from, { alias_to: alias.to }),
              copy("fork.personal.3e0303a34e"),
            )
          }
        >
          {copy("fork.personal.76c2d222e3")}
        </Button>
        <ul>
          {Object.entries(prefs.aliases).map(([from, to]) => (
            <li key={from}>
              {from} → {to}{" "}
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  run(
                    () => event("project_alias_remove", from),
                    copy("fork.personal.ca6f6c0ff6"),
                  )
                }
              >
                {copy("fork.personal.726ca479a9")}
              </Button>
            </li>
          ))}
        </ul>
        </div>
      </SectionCard>
      <SectionCard title={copy("fork.backup.title")}>
        <div className="space-y-4 py-3">
        <p className="text-sm">{copy("fork.backup.hint")}</p>
        <Button
          variant="secondary"
          size="sm"
                    disabled={busy}
          onClick={() =>
            run(async () => {
              const data = await forkApi("/api/fork/backup");
              const content = JSON.stringify(data);
              const filename = `tokentracker-local-backup-${new Date().toISOString().slice(0, 10)}.json`;
              const saved = await saveLocalUsageExport({
                filename,
                content,
                format: "json",
              });
              if (saved?.saved) return;
              const href = URL.createObjectURL(
                new Blob([content], { type: "application/json" }),
              );
              const a = document.createElement("a");
              a.href = href;
              a.download = filename;
              a.click();
              setTimeout(() => URL.revokeObjectURL(href), 1000);
            }, copy("fork.backup.exported"))
          }
        >
          {copy("fork.backup.export")}
        </Button>
        <label className="block">
          {copy("fork.backup.restore")}
          <input
            className="ml-3"
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void run(async () => {
                  if (file.size > 64 * 1024 * 1024)
                    throw new Error(copy("fork.backup.too_large"));
                  await forkApi("/api/fork/backup", {
                    method: "POST",
                    body: JSON.parse(await file.text()),
                  });
                }, copy("fork.backup.restored"));
              e.target.value = "";
            }}
          />
        </label>
        </div>
      </SectionCard>
    </div>
  );
}
