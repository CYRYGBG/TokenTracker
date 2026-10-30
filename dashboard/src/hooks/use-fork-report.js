import { useEffect, useState } from "react";
import { forkApi } from "../lib/fork-api";
import { buildReport } from "../lib/fork-reports";
import { LOCAL_USAGE_CHANGED_EVENT } from "../lib/local-usage-transfer";

export function useForkReport(period, timeZone, refreshKey) {
  const [state, setState] = useState({
    data: null,
    error: null,
    loading: true,
  });
  const identity = `${period.from}/${period.to}/${period.previousFrom}/${period.previousTo}/${timeZone}/${refreshKey}`;
  useEffect(() => {
    let active = true,
      request = 0;
    const refresh = async () => {
      const id = ++request;
      setState({ data: null, error: null, loading: true, identity });
      const query = (from, to) =>
        new URLSearchParams({
          from,
          to,
          device_id: "all",
          tz: timeZone || "",
          tz_offset_minutes: String(-new Date().getTimezoneOffset()),
        });
      const current = query(period.from, period.to),
        previous = query(period.previousFrom, period.previousTo);
      try {
        const [summary, prior, daily, breakdown, projects, devices] =
          await Promise.all([
            forkApi(`/functions/tokentracker-usage-summary?${current}`),
            forkApi(`/functions/tokentracker-usage-summary?${previous}`),
            forkApi(`/functions/tokentracker-usage-daily?${current}`),
            forkApi(`/functions/tokentracker-usage-model-breakdown?${current}`),
            forkApi(`/functions/tokentracker-project-usage-summary?${current}`),
            forkApi(`/api/fork/device-usage?${current}`),
          ]);
        if (active && request === id)
          setState({
            data: buildReport(period, {
              summary,
              previous: prior,
              daily,
              breakdown,
              projects,
              devices,
            }),
            error: null,
            loading: false,
            identity,
          });
      } catch (error) {
        if (active && request === id)
          setState({
            data: null,
            error: error.message,
            loading: false,
            identity,
          });
      }
    };
    refresh();
    const changed = () => {
      if (!document.hidden) refresh();
    };
    window.addEventListener(LOCAL_USAGE_CHANGED_EVENT, changed);
    document.addEventListener("visibilitychange", changed);
    return () => {
      active = false;
      window.removeEventListener(LOCAL_USAGE_CHANGED_EVENT, changed);
      document.removeEventListener("visibilitychange", changed);
    };
  }, [identity]);
  return state.identity === identity
    ? state
    : { data: null, error: null, loading: true };
}
