import { describe, expect, it } from "vitest";
import { reportPeriods, buildReport } from "./fork-reports";

describe("report calendar and reconciliation", () => {
  it("excludes today and aligns incomplete weeks with the same weekdays", () => {
    expect(reportPeriods("week", "2026-10-30")[0]).toMatchObject({
      from: "2026-10-26",
      to: "2026-10-29",
      previousFrom: "2026-10-19",
      previousTo: "2026-10-22",
      days: 4,
      previousDays: 4,
    });
    expect(reportPeriods("week", "2026-11-02")[0]).toMatchObject({
      from: "2026-10-26",
      to: "2026-11-01",
      days: 7,
    });
  });
  it("handles month starts, leap years and shorter previous months without pretending equal durations", () => {
    expect(reportPeriods("month", "2026-11-01")[0]).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-31",
      previousTo: "2026-09-30",
      days: 31,
      previousDays: 30,
    });
    expect(reportPeriods("month", "2024-03-01")[0]).toMatchObject({
      from: "2024-02-01",
      to: "2024-02-29",
      previousTo: "2024-01-29",
      days: 29,
    });
    expect(reportPeriods("week", "2026-03-09")[0]).toMatchObject({
      from: "2026-03-02",
      to: "2026-03-08",
      days: 7,
    });
  });
  const fixture = () => ({
    summary: { totals: { total_tokens: "100", total_cost_usd: "1.23" } },
    previous: { totals: { total_tokens: "50", total_cost_usd: "0.9" } },
    daily: {
      data: [{ day: "2026-10-26", total_tokens: "100", total_cost_usd: 1.23 }],
    },
    breakdown: {
      sources: [
        {
          source: "codex",
          totals: { total_tokens: "100" },
          models: [{ model_id: "m", totals: { total_tokens: "100" } }],
        },
      ],
    },
    projects: {
      entries: [
        {
          project_key: "repo",
          project_ref: "https://host/repo.git",
          total_tokens: "30",
          sources: [{ source: "codex", total_tokens: 30 }],
        },
      ],
    },
    devices: {
      devices: [{ id: "mac", device_name: "Mac", total_tokens: 100 }],
      account_sources: [],
    },
  });
  it("fills missing dates, retains unattributed usage, and uses existing historical cost", () => {
    const report = buildReport(
      reportPeriods("week", "2026-10-30")[0],
      fixture(),
    );
    expect(report.days.map((d) => d.tokens)).toEqual([100, 0, 0, 0]);
    expect(report.cost).toBe(1.23);
    expect(report.activeDays).toBe(1);
    expect(report.unassigned).toBe(70);
    expect(report.unassignedTools).toEqual([{ name: "codex", tokens: 70 }]);
    expect(report.projects[0].name).toBe("repo");
    expect(report.incomplete).toBe(false);
  });
  it("keeps account-wide sources separate from devices and recognizes incomplete data", () => {
    const f = fixture();
    f.devices.devices[0].total_tokens = 60;
    f.devices.account_sources = [{ source: "cursor", total_tokens: 40 }];
    expect(
      buildReport(reportPeriods("week", "2026-10-30")[0], f).incomplete,
    ).toBe(false);
    f.previous.partial = true;
    expect(
      buildReport(reportPeriods("week", "2026-10-30")[0], f).incomplete,
    ).toBe(true);
  });
  it("does not attribute source-only fallback rows to projects or mislabel a capped result", () => {
    const f = fixture();
    f.projects.entries = Array.from({ length: 10 }, (_, i) => ({
      project_key: String(i),
      total_tokens: 10,
      sources: [],
    }));
    const r = buildReport(reportPeriods("week", "2026-10-30")[0], f);
    expect(r.projects).toEqual([]);
    expect(r.unassigned).toBe(100);
    expect(r.limitedProjects).toBe(true);
  });
});
