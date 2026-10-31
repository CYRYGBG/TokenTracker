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
      // One aggregate request: the backend computes every payload from a
      // single shared history load instead of six parallel full reads.
      const query = new URLSearchParams({
        from: period.from,
        to: period.to,
        previous_from: period.previousFrom,
        previous_to: period.previousTo,
        device_id: "all",
        tz: timeZone || "",
        tz_offset_minutes: String(-new Date().getTimezoneOffset()),
      });
      try {
        const report = await forkApi(`/api/fork/report?${query}`);
        if (active && request === id)
          setState({
            data: buildReport(period, report),
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
