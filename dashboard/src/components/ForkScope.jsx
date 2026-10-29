import { copy } from "../lib/copy";
import React, { useEffect, useState } from "react";
import { forkApi } from "../lib/fork-api";
// Device scoping lives in the official in-card dropdown (UsageOverview).
// Only partial-sync warnings need a status strip under the app header.
export function ForkScope() {
  const [state, setState] = useState(null);
  useEffect(() => {
    forkApi("/api/fork/view")
      .then(async (s) => {
        setState(s);
        // The scope selector moved into the dashboard card and now scopes
        // per-request. A device left selected in the legacy saved preference
        // would silently filter scope-less callers (sessions/projects), so
        // retire any non-default value once.
        if (s?.device && s.device !== "all") {
          await forkApi("/api/fork/view", { method: "PUT", body: { device: "all" } });
        }
      })
      .catch(() => {});
  }, []);
  if (!state?.partial) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-oai-gray-200 px-6 py-3 text-sm dark:border-oai-gray-800">
      <span role="status">
        {copy("fork.personal.7d0ecab92a")}
        {state.last_failure?.code}
      </span>
    </div>
  );
}
