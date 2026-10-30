import { copy } from "../lib/copy";
import React, { useEffect, useState } from "react";
import { forkApi } from "../lib/fork-api";
import { Link } from "react-router-dom";
import {
  describeSyncFailure,
  FORK_SYNC_CHANGED_EVENT,
} from "../lib/fork-sync-status";
// Device scoping lives in the official in-card dropdown (UsageOverview).
// Only partial-sync warnings need a status strip under the app header.
export function ForkScope() {
  const [state, setState] = useState(null);
  useEffect(() => {
    let active = true,
      request = 0,
      retired = false;
    const refresh = () => {
      const id = ++request;
      return forkApi("/api/fork/view")
        .then(async (s) => {
          if (!active || id !== request) return;
          setState(s);
          // The scope selector moved into the dashboard card and now scopes
          // per-request. A device left selected in the legacy saved preference
          // would silently filter scope-less callers (sessions/projects), so
          // retire any non-default value once.
          if (!retired && s?.device && s.device !== "all") {
            retired = true;
            await forkApi("/api/fork/view", {
              method: "PUT",
              body: { device: "all" },
            });
          }
        })
        .catch(() => {});
    };
    refresh();
    const visible = () => {
      if (!document.hidden) refresh();
    };
    const timer = setInterval(visible, 15000);
    window.addEventListener(FORK_SYNC_CHANGED_EVENT, refresh);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(FORK_SYNC_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  if (!state?.partial) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-oai-gray-200 px-6 py-3 text-sm dark:border-oai-gray-800">
      <span role="status">
        {copy("fork.personal.7d0ecab92a")}
        {describeSyncFailure(state.last_failure || { code: "WEBDAV_PARTIAL" })}
      </span>
      <Link className="underline text-xs" to="/settings?section=sync">
        {copy("fork.sync.details")}
      </Link>
    </div>
  );
}
