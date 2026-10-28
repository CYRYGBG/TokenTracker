import React from "react";
import { RefreshCw } from "lucide-react";
import { useNativeSettings } from "../../hooks/use-native-settings.js";
import { copy } from "../../lib/copy";
import { cn } from "../../lib/cn";
import { isNativeWindowsApp } from "../../lib/native-bridge.js";
import { FALLBACK_MENU_BAR_ITEMS, MENU_BAR_NONE_ID, normalizeMenuBarItems } from "../../lib/menu-bar-display.js";
import { Select } from "../../ui/components";
import { SectionCard, SettingsRow, ToggleSwitch } from "./Controls.jsx";
import { Button } from "../../ui/components/Button.jsx";

function metricLabel(id, fallback) {
  switch (id) {
    case MENU_BAR_NONE_ID:
      return copy("menubar.metric.none");
    case "todayTokens":
      return copy("menubar.metric.today_tokens");
    case "todayCost":
      return copy("menubar.metric.today_cost");
    case "last7dTokens":
      return copy("menubar.metric.last_7d_tokens");
    case "totalTokens":
      return copy("menubar.metric.total_tokens");
    case "totalCost":
      return copy("menubar.metric.total_cost");
    case "claude5h":
      return copy("menubar.metric.claude_5h");
    case "claude7d":
      return copy("menubar.metric.claude_7d");
    case "codex5h":
      return copy("menubar.metric.codex_5h");
    case "codex7d":
      return copy("menubar.metric.codex_7d");
    case "codexCredits":
      return copy("menubar.metric.codex_credits");
    case "codexSpark5h":
      return copy("menubar.metric.codex_spark_5h");
    case "codexSpark7d":
      return copy("menubar.metric.codex_spark_7d");
    default:
      return fallback;
  }
}

// Keep the upstream metric IDs and normalization while exposing their controls
// directly in settings: the personal app does not ship the widget gallery route.
function MenuBarDisplayControls({ settings, setSetting }) {
  const nativeItems = settings?.menuBarAvailableItems;
  const items = Array.isArray(nativeItems) && nativeItems.length ? nativeItems : FALLBACK_MENU_BAR_ITEMS;
  const options = items.some((item) => item.id === MENU_BAR_NONE_ID)
    ? items : [{ id: MENU_BAR_NONE_ID, label: copy("menubar.metric.none") }, ...items];
  const selected = normalizeMenuBarItems(settings?.menuBarItems, options, 2);
  const showStats = settings?.showStats !== false;
  return <>
    <SettingsRow
      label={copy("settings.menubar.showStats")}
      hint={copy("settings.menubar.showStatsHint")}
      control={<ToggleSwitch checked={showStats} onChange={() => setSetting("showStats", !showStats)} ariaLabel={copy("settings.menubar.showStats")} />}
    />
    <p className="px-4 py-2 text-xs text-oai-gray-500">{copy("fork.menubar.five_hour_hint")}</p>
    {[0, 1].map((slot) => {
      const label = copy(slot === 0 ? "menubar.slot.primary" : "menubar.slot.secondary");
      const value = selected[slot] || MENU_BAR_NONE_ID;
      return <SettingsRow key={slot} label={label} control={
        <Select value={value} disabled={!showStats} ariaLabel={label}
          options={options.filter((item) => item.id === MENU_BAR_NONE_ID || item.id === value || !selected.includes(item.id))
            .map((item) => ({ value: item.id, label: metricLabel(item.id, item.label) }))}
          onValueChange={(next) => {
            const ids = [selected[0] || MENU_BAR_NONE_ID, selected[1] || MENU_BAR_NONE_ID];
            ids[slot] = next;
            setSetting("menuBarItems", normalizeMenuBarItems(ids, options, 2));
          }}
          className="min-w-40 px-3 py-2 text-sm"
        />
      } />;
    })}
  </>;
}

export function MenuBarSection() {
  const { available, settings, setSetting, runAction } = useNativeSettings();
  if (!available) return null;
  const isWindows = isNativeWindowsApp();

  const launchAtLogin = Boolean(settings?.launchAtLogin);
  const toastOnReset = settings?.toastOnReset !== false;
  const confettiOnReset = settings?.confettiOnReset !== false;
  const launchAtLoginSupported = settings?.launchAtLoginSupported !== false;
  const isSyncing = Boolean(settings?.isSyncing);

  return (
    <SectionCard title={copy("settings.section.menubar")}>
      {!isWindows ? (
        <>
          <MenuBarDisplayControls settings={settings} setSetting={setSetting} />
          <SettingsRow
            label={copy("settings.menubar.toastOnReset")}
            hint={copy("settings.menubar.toastOnResetHint")}
            control={
              <ToggleSwitch
                checked={toastOnReset}
                onChange={() => setSetting("toastOnReset", !toastOnReset)}
                ariaLabel={copy("settings.menubar.toastOnReset")}
              />
            }
          />
          <SettingsRow
            label={copy("settings.menubar.confettiOnReset")}
            hint={copy("settings.menubar.confettiOnResetHint")}
            control={
              <ToggleSwitch
                checked={confettiOnReset}
                onChange={() => setSetting("confettiOnReset", !confettiOnReset)}
                ariaLabel={copy("settings.menubar.confettiOnReset")}
              />
            }
          />
        </>
      ) : null}
      {launchAtLoginSupported ? (
        <SettingsRow
          label={copy("settings.menubar.launchAtLogin")}
          hint={copy("settings.menubar.launchAtLoginHint")}
          control={
            <ToggleSwitch
              checked={launchAtLogin}
              onChange={() => setSetting("launchAtLogin", !launchAtLogin)}
              ariaLabel={copy("settings.menubar.launchAtLogin")}
            />
          }
        />
      ) : null}
      <SettingsRow
        label={copy("settings.menubar.autoUpdate")}
        hint={copy("fork.updates.channel_hint")}
        control={<ToggleSwitch checked={Boolean(settings?.autoUpdateEnabled)}
          onChange={() => setSetting("autoUpdateEnabled", !settings?.autoUpdateEnabled)}
          ariaLabel={copy("settings.menubar.autoUpdate")} />}
      />
      <SettingsRow label={copy("settings.menubar.checkUpdates")}
        hint={settings?.updateStatus || settings?.version}
        control={<Button variant="secondary" size="sm" disabled={Boolean(settings?.updateBusy)}
          onClick={() => runAction("checkForUpdates")}>{copy("settings.menubar.checkUpdates")}</Button>}
      />
      <SettingsRow
        label={copy("settings.menubar.syncNow")}
        hint={copy("settings.menubar.syncNowHint")}
        control={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => runAction("syncNow")}
            disabled={isSyncing}
            className="gap-1.5"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isSyncing && "animate-spin")} aria-hidden />
            <span>{isSyncing ? copy("settings.menubar.syncing") : copy("settings.menubar.syncNow")}</span>
          </Button>
        }
      />
    </SectionCard>
  );
}


export function NativeAppFooter() { return null; }
