import { copy } from "../lib/copy";
import React, { useEffect, useState } from "react";
import { forkApi } from "../lib/fork-api";
// Status strip under the app header. Device scoping lives in the official
// in-card dropdown on the dashboard (UsageOverview), which sends a per-request
// device_id — this bar only reports verified spending and partial-sync state.
export function ForkScope() {
  const [state, setState] = useState(null);
  const [spending, setSpending] = useState({});
  const [error, setError] = useState("");
  useEffect(() => {
    forkApi("/api/fork/prefs")
      .then((p) => setSpending(p.spending_by_currency || {}))
      .catch((e) => setError(e.message));
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
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-oai-gray-200 px-6 py-3 text-sm dark:border-oai-gray-800">
      <span className="text-oai-gray-500">
        {copy("fork.spending.label")}{" "}
        {Object.entries(spending)
          .map(([currency, amount]) => `${amount} ${currency}`)
          .join(" · ") || copy("fork.spending.none")}
      </span>
      {state?.partial && (
        <span role="status">
          {copy("fork.personal.7d0ecab92a")}
          {state.last_failure?.code}
        </span>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
