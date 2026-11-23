import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDayKey } from "./use-day-key";

describe("useDayKey rollover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recomputes the day key when the local day rolls over", () => {
    // 2026-11-23 23:58 Beijing (UTC+8, +480) = 15:58Z.
    vi.setSystemTime(new Date("2026-11-23T15:58:00.000Z"));
    const view = renderHook(() => useDayKey({ offsetMinutes: 480 }));
    expect(view.result.current).toBe("2026-11-23");

    // Cross midnight into 2026-11-24 Beijing; the one-minute check flips the
    // key, which is what lets the dashboard's range memos re-run and the
    // usage hooks refetch past a stale from/to.
    act(() => {
      vi.setSystemTime(new Date("2026-11-23T16:01:00.000Z"));
      vi.advanceTimersByTime(60_000);
    });
    expect(view.result.current).toBe("2026-11-24");
  });

  it("keeps ticking until the day changes and then stays stable", () => {
    vi.setSystemTime(new Date("2026-11-23T15:58:00.000Z"));
    const view = renderHook(() => useDayKey({ offsetMinutes: 480 }));
    expect(view.result.current).toBe("2026-11-23");

    // Minutes that do not cross midnight must not change the key (setting
    // the same value bails out, so no render churn).
    act(() => {
      vi.setSystemTime(new Date("2026-11-23T15:58:30.000Z"));
      vi.advanceTimersByTime(60_000);
    });
    expect(view.result.current).toBe("2026-11-23");

    act(() => {
      vi.setSystemTime(new Date("2026-11-23T16:00:30.000Z"));
      vi.advanceTimersByTime(120_000);
    });
    expect(view.result.current).toBe("2026-11-24");
  });

  it("stays frozen on the provided now (mock/screenshot mode)", () => {
    vi.setSystemTime(new Date("2026-11-23T15:58:00.000Z"));
    const frozen = new Date("2026-11-20T10:00:00.000Z");
    const view = renderHook(() => useDayKey({ offsetMinutes: 480, now: frozen }));
    expect(view.result.current).toBe("2026-11-20");

    act(() => {
      vi.setSystemTime(new Date("2026-11-24T12:00:00.000Z"));
      vi.advanceTimersByTime(180_000);
    });
    expect(view.result.current).toBe("2026-11-20");
  });

  it("follows an explicit timeZone label", () => {
    // 2026-11-23 20:00 UTC is already 2026-11-24 in Shanghai.
    vi.setSystemTime(new Date("2026-11-23T20:00:00.000Z"));
    const view = renderHook(() => useDayKey({ timeZone: "Asia/Shanghai" }));
    expect(view.result.current).toBe("2026-11-24");
  });
});
