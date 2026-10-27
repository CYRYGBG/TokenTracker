import { copy } from "../lib/copy";
import React, { useEffect, useState } from "react";
import { forkApi } from "../lib/fork-api";
export function ForkScope() {
  const [state, setState] = useState(null);
  const [spending, setSpending] = useState({});
  const [error, setError] = useState("");
  useEffect(() => {
    forkApi("/api/fork/view")
      .then(setState)
      .catch((e) => setError(e.message));
    forkApi("/api/fork/prefs")
      .then((p) => setSpending(p.spending_by_currency || {}))
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-oai-gray-200 px-6 py-3 text-sm dark:border-oai-gray-800">
      <label>
        {copy("fork.personal.174fd6f85c")}
        <select
          aria-label={copy("fork.personal.174fd6f85c")}
          className="rounded border bg-transparent p-1"
          value={state?.device || "all"}
          disabled={!state}
          onChange={async (e) => {
            try {
              await forkApi("/api/fork/view", {
                method: "PUT",
                body: { device: e.target.value },
              });
              window.location.reload();
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          <option value="all">{copy("fork.personal.fb9b2c7f31")}</option>
          <option value="local">{copy("fork.personal.8b4c1c5f0c")}</option>
          {state?.devices
            ?.filter((d) => !d.local)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name || d.id}
              </option>
            ))}
        </select>
      </label>
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
