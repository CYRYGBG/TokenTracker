import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage.jsx";

// DashboardPage composes nearly every data hook in the app but has no
// slice-state of its own, so this suite renders the page with inert hook
// mocks and asserts the body executes — most notably the useMemo dependency
// arrays, where a use-before-declare `const` reference is a guaranteed
// first-render crash (the 1.5.11 outage: `todayKey` read in the `range`
// memo deps ~160 lines before its declaration; tsc does not check .jsx and
// no test rendered the page, so it shipped and broke both platforms).
vi.mock("../contexts/AccountViewContext.jsx", () => ({
  useAccountView: () => ({ accountView: false, revision: 0, resolving: false }),
}));
vi.mock("../hooks/use-account-devices", () => ({
  useAccountDevices: () => ({ devices: [], accountSources: [], refresh: vi.fn(), loading: false, revision: 0 }),
}));
vi.mock("../hooks/use-usage-data", () => ({
  useUsageData: () => ({ daily: [], summary: null, rolling: [], source: "local", loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../hooks/use-usage-model-breakdown", () => ({
  useUsageModelBreakdown: () => ({ breakdown: [], loading: false, refresh: vi.fn() }),
}));
vi.mock("../hooks/use-project-usage-summary", () => ({
  useProjectUsageSummary: () => ({ entries: [], loading: false, refresh: vi.fn() }),
}));
vi.mock("../hooks/use-trend-data", () => ({
  useTrendData: () => ({ rows: [], from: null, to: null, loading: false, refresh: vi.fn() }),
}));
vi.mock("../hooks/use-activity-heatmap", () => ({
  useActivityHeatmap: () => ({ daily: [], heatmap: null, loading: false, refresh: vi.fn() }),
}));
vi.mock("../hooks/use-usage-limits", () => ({
  useUsageLimits: () => ({ data: null, refresh: vi.fn() }),
}));
vi.mock("../hooks/useLocale.js", () => ({
  useLocale: () => ({ resolvedLocale: "zh" }),
}));
vi.mock("../hooks/useCurrency.js", () => ({
  useCurrency: () => ({ currency: "USD", rate: 1 }),
}));
vi.mock("../hooks/useTokenFormat.js", () => ({
  useTokenFormat: () => ({
    mode: "si",
    setMode: vi.fn(),
    formatTokens: (value) => String(value ?? 0),
    formatTokensTooltip: null,
  }),
}));

// Heavy children: their internals are covered by their own suites. Inert
// markers keep this test about the page body, not three.js/chart code.
vi.mock("../ui/dashboard/views/DashboardView.jsx", () => ({
  DashboardView: () => <div data-testid="dashboard-page-shell">dashboard-shell-ok</div>,
}));
vi.mock("../ui/dashboard/components/ActivityHeatmap.jsx", () => ({
  ActivityHeatmap: () => <div data-testid="activity-heatmap-mock" />,
}));
vi.mock("../ui/share/ShareModal", () => ({ ShareModal: () => null }));
vi.mock("../ui/share/use-share-card-data", () => ({ useShareCardData: () => null }));
vi.mock("../components/ForkDeviceUsageCard.jsx", () => ({ ForkDeviceUsageCard: () => null }));
vi.mock("../ui/dashboard/components/DeviceUsageCard.jsx", () => ({ DeviceUsageCard: () => null }));

// Network-touching libs: the page must render with no backend present.
vi.mock("../lib/fork-api", () => ({
  forkApi: vi.fn(async () => ({ view: { buckets: [] }, devices: [] })),
}));
vi.mock("../lib/api", () => ({
  getUserStatus: vi.fn(async () => null),
  invalidateAccountResponseCache: vi.fn(),
  invalidateSessionInsightsCache: vi.fn(),
  triggerLocalSync: vi.fn(async () => null),
  renameAccountDevice: vi.fn(),
}));
vi.mock("../lib/local-usage-auto-refresh", () => ({
  startLocalUsageAutoRefresh: vi.fn(() => ({ stop: vi.fn() })),
}));

// useDayKey stays REAL on purpose: it is the rollover-aware hook every
// request range here depends on (see use-day-key.test.tsx for its own suite).

describe("DashboardPage render regression", () => {
  it("renders the dashboard body without crashing on first mount", async () => {
    window.scrollTo = vi.fn(); // jsdom: unimplemented, throws on callers
    render(<DashboardPage auth="token" signedIn onMainContentVisible={() => {}} />);
    // The error boundary replaces children with its own card when a render
    // throws, so the shell's presence proves the body executed end to end.
    const shell = await screen.findByTestId("dashboard-page-shell", {}, { timeout: 4000 });
    expect(shell).toBeTruthy();
  });
});
