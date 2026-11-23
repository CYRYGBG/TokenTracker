import { useCallback, useEffect, useState } from "react";
import { getLocalDayKey } from "../lib/timezone";

type DayKeyOptions = {
  timeZone?: string | null;
  offsetMinutes?: number | null;
  /** Frozen "now" for tests/screenshot mode: disables rollover tracking. */
  now?: Date | null;
};

// The dashboard anchors every request range to "today". Computing that key
// once at mount (a `useMemo` over `new Date()`) freezes the whole page on the
// mount day: the tray app keeps the WebView alive for days, so from/to stop
// advancing, the daily breakdown drops the days after mount, and manual
// refresh re-requests the same stale range (#daily-breakdown stale today).
// Re-check the key on an interval; setting the same value is a no-op for
// React, so re-renders only happen when the local day actually rolls over.
export function useDayKey({ timeZone, offsetMinutes, now }: DayKeyOptions = {}) {
  const compute = useCallback(
    () =>
      getLocalDayKey({
        timeZone: timeZone ?? undefined,
        offsetMinutes: offsetMinutes ?? undefined,
        date: now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date(),
      }),
    [timeZone, offsetMinutes, now],
  );

  const [dayKey, setDayKey] = useState(compute);

  useEffect(() => {
    setDayKey(compute());
  }, [compute]);

  useEffect(() => {
    if (now instanceof Date && Number.isFinite(now.getTime())) return;
    const timer = setInterval(() => {
      setDayKey((prev) => {
        const next = compute();
        return next === prev ? prev : next;
      });
    }, 60_000);
    return () => clearInterval(timer);
  }, [compute, now]);

  return dayKey;
}
