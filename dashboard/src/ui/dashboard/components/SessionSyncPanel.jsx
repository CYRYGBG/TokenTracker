import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Button, Card } from "../../components";
import { ProviderIcon } from "./ProviderIcon.jsx";
import { copy } from "../../../lib/copy";
import { cn } from "../../../lib/cn";
import { formatBytes } from "../../../lib/bytes";
import { formatDeviceLabel } from "../../../lib/device-label";
import {
  SESSION_SYNC_CHANGED_EVENT,
  agentLabel,
  describeSessionSyncFailure,
  fetchLocalConversations,
  fetchRemoteConversations,
  fetchSessionSyncStatus,
  importConversations,
  refreshRemoteConversations,
  uploadConversations,
} from "../../../lib/session-sync";

/// Local-time "YYYY-MM-DD HH:mm" — a recall aid, no seconds, no UTC suffix.
function formatSyncMinute(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const p2 = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())} ${p2(date.getHours())}:${p2(date.getMinutes())}`;
}

function providerForAgent(agent) {
  if (agent === "codex") return "CODEX";
  if (agent === "zcode") return "ZCODE";
  if (agent === "antigravity") return "ANTIGRAVITY";
  return null;
}

function uploadBadge(uploaded) {
  if (!uploaded) return null;
  return (
    <Badge variant="secondary">{copy("session_sync.badge.uploaded", { revision: uploaded.revision })}</Badge>
  );
}

function remoteBadge(imported) {
  if (!imported) return null;
  if (imported.hasUpdate) {
    return <Badge variant="info">{copy("session_sync.badge.update_available")}</Badge>;
  }
  return <Badge variant="success">{copy("session_sync.badge.imported", { revision: imported.revision })}</Badge>;
}

function ConversationRow({ checked, onToggle, icon, title, meta, badge, disabled }) {
  return (
    <li className="flex min-w-0 items-center gap-3 px-4 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        aria-label={title}
        className="h-4 w-4 shrink-0"
      />
      {icon}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-oai-black dark:text-white">{title}</p>
        <p className="mt-0.5 truncate text-xs text-oai-gray-500 dark:text-oai-gray-400">{meta}</p>
      </div>
      {badge}
    </li>
  );
}

export function SessionSyncPanel() {
  const [local, setLocal] = useState(null);
  const [remote, setRemote] = useState(null);
  const [status, setStatus] = useState(null);
  const [selectedUpload, setSelectedUpload] = useState(() => new Set());
  const [selectedImport, setSelectedImport] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [refreshingRemote, setRefreshingRemote] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState("");
  const pollTimer = useRef(null);

  const localItems = useMemo(() => (Array.isArray(local?.items) ? local.items : []), [local]);
  const uploadable = useMemo(
    () => localItems.filter((item) => item.agent && item.sessionId),
    [localItems],
  );
  const remoteDevices = useMemo(() => (remote && typeof remote === "object" ? remote : null), [remote]);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const [nextLocal, nextRemote, nextStatus] = await Promise.all([
        fetchLocalConversations().catch(() => null),
        fetchRemoteConversations().catch(() => null),
        fetchSessionSyncStatus().catch(() => null),
      ]);
      setLocal(nextLocal);
      setRemote(nextRemote);
      setStatus(nextStatus);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onChanged = () => void load({ quiet: true });
    window.addEventListener(SESSION_SYNC_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SESSION_SYNC_CHANGED_EVENT, onChanged);
  }, [load]);

  // Poll while a job is running so progress and per-item results appear.
  const jobRunning = status?.job?.state === "running";
  useEffect(() => {
    if (!jobRunning) {
      if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
      return;
    }
    const tick = async () => {
      try {
        const next = await fetchSessionSyncStatus();
        setStatus(next);
        if (next?.job?.state !== "running") {
          window.dispatchEvent(new Event(SESSION_SYNC_CHANGED_EVENT));
          return;
        }
      } catch { /* transient poll failure: keep polling */ }
      pollTimer.current = setTimeout(tick, 1200);
    };
    pollTimer.current = setTimeout(tick, 1200);
    return () => { if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; } };
  }, [jobRunning]);

  const lastJobItems = status?.job?.items || [];
  const jobItemKey = (item) => `${item.device || ""}:${item.agent}:${item.sessionId}`;

  const toggleSelection = (set, key) => {
    set((prior) => {
      const next = new Set(prior);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  async function runUpload() {
    setActionBusy(true); setError("");
    try {
      const items = uploadable
        .filter((item) => selectedUpload.has(`${item.agent}:${item.sessionId}`))
        .map((item) => ({ agent: item.agent, sessionId: item.sessionId }));
      if (items.length === 0) return;
      const result = await uploadConversations(items);
      if (result?.code) {
        setError(describeSessionSyncFailure(result.code));
        return;
      }
      if (!result?.ok) {
        setError(describeSessionSyncFailure(result?.code));
        return;
      }
      setSelectedUpload(new Set());
      // The job runs detached; polling drives the progress display.
      setStatus((prior) => ({ ...prior, job: { ...(prior?.job || {}), state: "running" } }));
    } catch (e) {
      setError(e?.code ? describeSessionSyncFailure(e.code) : copy("session_sync.error.generic"));
    } finally {
      setActionBusy(false);
    }
  }

  async function runImport() {
    setActionBusy(true); setError("");
    try {
      const items = [];
      for (const [deviceId, device] of Object.entries(remoteDevices?.devices || {})) {
        for (const session of device.sessions || []) {
          if (selectedImport.has(`${deviceId}:${session.agent}:${session.session_id}`)) {
            items.push({ device: deviceId, agent: session.agent, sessionId: session.session_id });
          }
        }
      }
      if (items.length === 0) return;
      const result = await importConversations(items);
      if (!result?.ok) {
        setError(describeSessionSyncFailure(result?.code));
        return;
      }
      setSelectedImport(new Set());
      setStatus((prior) => ({ ...prior, job: { ...(prior?.job || {}), state: "running" } }));
    } catch (e) {
      setError(e?.code ? describeSessionSyncFailure(e.code) : copy("session_sync.error.generic"));
    } finally {
      setActionBusy(false);
    }
  }

  async function runRefreshRemote() {
    setRefreshingRemote(true); setError("");
    try {
      const result = await refreshRemoteConversations();
      if (!result?.ok) {
        setError(describeSessionSyncFailure(result?.code || "REFRESH_FAILED"));
        return;
      }
      await load({ quiet: true });
    } catch (e) {
      setError(e?.code ? describeSessionSyncFailure(e.code) : copy("session_sync.error.generic"));
    } finally {
      setRefreshingRemote(false);
    }
  }

  const jobItems = (status?.job && status.job.state !== "running")
    ? (Array.isArray(status.job.items) ? status.job.items : [])
    : [];
  const jobErrors = jobItems.filter((item) => { return item.status === "error"; });
  const jobDone = jobItems.filter((item) => { return item.status === "done"; });

  const remoteFetchedAt = formatSyncMinute(remoteDevices?.fetchedAt);

  return (
    <div className="space-y-6">
      {jobRunning ? (
        <p role="status" className="text-sm text-oai-gray-600 dark:text-oai-gray-300">
          {copy("session_sync.job.running")}
        </p>
      ) : null}
      {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {jobItems.length !== 0 ? (
        <div className="space-y-1 text-sm">
          {jobDone.length !== 0 ? (
            <p role="status" className="text-oai-gray-600 dark:text-oai-gray-300">
              {copy("session_sync.job.done_count", { count: jobDone.length })}
            </p>
          ) : null}
          {jobErrors.length !== 0 ? (
            <ul className="space-y-1" role="alert">
              {jobErrors.map((item) => (
                <li key={jobItemKey(item)} className="text-red-600 dark:text-red-400">
                  {`${agentLabel(item.agent)} · ${copy("session_sync.job.item_failed")}: ${describeSessionSyncFailure(item.code)}`}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <Card
        title={copy("session_sync.local.title")}
        subtitle={copy("session_sync.local.subtitle")}
        bodyClassName="p-0"
      >
        {(() => {
          if (loading && !local) {
            return <p className="px-4 py-6 text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("session_sync.state.loading")}</p>;
          }
          if (uploadable.length === 0) {
            return <p className="px-4 py-6 text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("session_sync.local.empty")}</p>;
          }
          return (
          <>
            <ul className="divide-y divide-oai-gray-200/60 dark:divide-oai-gray-800/60">
              {uploadable.map((item) => {
                const key = `${item.agent}:${item.sessionId}`;
                const uploaded = item.upload;
                return (
                  <ConversationRow
                    key={key}
                    checked={selectedUpload.has(key)}
                    onToggle={() => toggleSelection(setSelectedUpload, key)}
                    disabled={actionBusy || jobRunning}
                    icon={<ProviderIcon provider={providerForAgent(item.agent)} size={16} className="h-4 w-4 shrink-0" />}
                    title={item.title || copy("session_sync.row.untitled")}
                    meta={`${agentLabel(item.agent)} · ${formatSyncMinute(new Date(item.updatedAtMs || 0).toISOString()) || "—"} · ${formatBytes(item.bytes)}`}
                    badge={uploadBadge(uploaded)}
                  />
                );
              })}
            </ul>
            <div className="flex items-center justify-between gap-3 border-t border-oai-gray-200/60 px-4 py-3 dark:border-oai-gray-800/60">
              <button
                type="button"
                className="text-xs text-oai-gray-600 underline decoration-oai-gray-300 underline-offset-4 hover:text-oai-black disabled:opacity-50 dark:text-oai-gray-300 dark:decoration-oai-gray-600 dark:hover:text-white"
                disabled={actionBusy || jobRunning || uploadable.length === 0}
                onClick={() => setSelectedUpload((prior) =>
                  prior.size === uploadable.length ? new Set() : new Set(uploadable.map((item) => `${item.agent}:${item.sessionId}`)))}
              >
                {selectedUpload.size === uploadable.length && uploadable.length !== 0
                  ? copy("session_sync.action.unselect_all")
                  : copy("session_sync.action.select_all")}
              </button>
              <Button
                variant="primary"
                size="sm"
                disabled={actionBusy || jobRunning || selectedUpload.size === 0}
                onClick={() => void runUpload()}
              >
                {copy("session_sync.action.upload", { count: selectedUpload.size })}
              </Button>
            </div>
          </>
          );
        })()}
      </Card>

      <Card
        title={copy("session_sync.remote.title")}
        subtitle={remoteFetchedAt
          ? copy("session_sync.remote.fetched_at", { time: remoteFetchedAt })
          : copy("session_sync.remote.subtitle")}
        action={
          <Button variant="secondary" size="sm" disabled={refreshingRemote || actionBusy || jobRunning} onClick={() => void runRefreshRemote()}>
            <RefreshCw className={cn("h-3.5 w-3.5", refreshingRemote && "animate-spin")} aria-hidden />
            {copy("session_sync.action.refresh_remote")}
          </Button>
        }
        bodyClassName="p-0"
      >
        {!remoteDevices || Object.keys(remoteDevices.devices || {}).length === 0 ? (
          <p className="px-4 py-6 text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("session_sync.remote.empty")}</p>
        ) : (
          Object.entries(remoteDevices.devices).map(([deviceId, device]) => (
            <div key={deviceId} className="border-t border-oai-gray-200/60 first:border-t-0 dark:border-oai-gray-800/60">
              <p className="px-4 pt-3 text-xs font-medium uppercase tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
                {formatDeviceLabel({ id: deviceId, device_name: device.name, platform: device.platform })}
              </p>
              {(device.sessions || []).length === 0 ? (
                <p className="px-4 pb-3 pt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("session_sync.remote.device_empty")}</p>
              ) : (
                <ul className="mt-1 divide-y divide-oai-gray-200/60 dark:divide-oai-gray-800/60">
                  {(device.sessions || []).map((session) => {
                    const key = `${deviceId}:${session.agent}:${session.session_id}`;
                    const imported = session.imported;
                    return (
                      <ConversationRow
                        key={key}
                        checked={selectedImport.has(key)}
                        onToggle={() => toggleSelection(setSelectedImport, key)}
                        disabled={actionBusy || jobRunning}
                        icon={<ProviderIcon provider={providerForAgent(session.agent)} size={16} className="h-4 w-4 shrink-0" />}
                        title={session.title || copy("session_sync.row.untitled")}
                        meta={`${agentLabel(session.agent)} · ${formatSyncMinute(session.updated_at) || "—"} · ${formatBytes(session.bytes)}`}
                        badge={remoteBadge(imported)}
                      />
                    );
                  })}
                </ul>
              )}
            </div>
          ))
        )}
        {remoteDevices && Object.keys(remoteDevices.devices || {}).length !== 0 ? (
          <div className="flex items-center justify-end gap-3 border-t border-oai-gray-200/60 px-4 py-3 dark:border-oai-gray-800/60">
            <Button
              variant="primary"
              size="sm"
              disabled={actionBusy || jobRunning || selectedImport.size === 0}
              onClick={() => void runImport()}
            >
              {copy("session_sync.action.import", { count: selectedImport.size })}
            </Button>
          </div>
        ) : null}
      </Card>
      <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("session_sync.privacy_note")}</p>
    </div>
  );
}
