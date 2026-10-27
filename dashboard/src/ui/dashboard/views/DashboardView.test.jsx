import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { copy } from "../../../lib/copy";
import { DashboardView } from "./DashboardView.jsx";

const loadingCard = vi.hoisted(() => ({ pending: true, mounts: 0, unmounts: 0 }));

vi.mock("../../components", () => ({ Shell: ({ children }) => <>{children}</>, Card: ({ children }) => <>{children}</> }));
vi.mock("../../foundation/FadeIn.jsx", () => ({ FadeIn: ({ children }) => <>{children}</> }));
vi.mock("../components/StatsPanel.jsx", () => ({ StatsPanel: () => <section data-testid="stats" /> }));
vi.mock("../components/UsageOverview.jsx", () => ({ UsageOverview: () => <section data-testid="usage" /> }));
vi.mock("../components/CostAnalysisModal.jsx", () => ({ CostAnalysisModal: () => null }));
vi.mock("../components/QualityPerDollarCard.jsx", async () => {
  const { useEffect } = await import("react");
  return { QualityPerDollarCard: function Card() {
    useEffect(() => {
      loadingCard.mounts++;
      return () => { loadingCard.unmounts++; };
    }, []);
    if (loadingCard.pending) return null;
    return <section data-testid="quality" />;
  } };
});

afterEach(cleanup);

it("ignores removed promotional cards in saved layouts without leaving draggable empty slots", () => {
  render(<DashboardView copy={copy} isLocalMode
    leftCardOrder={["islandOnboarding", "linuxPetCard", "macAppBanner", "widgetOnboarding", "linuxTopBarCard", "statsPanel"]}
    rightCardOrder={["usageOverview"]} />);
  expect(screen.getByTestId("stats")).toBeInTheDocument();
  expect(screen.getByTestId("usage")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: copy("dashboard.overview.layout.drag_handle") })).toHaveLength(2);
});

it("ignores the retired quality experiment in saved layouts", () => {
  loadingCard.mounts=0;render(<DashboardView copy={copy} isLocalMode leftCardOrder={["qualityPerDollar"]} rightCardOrder={["usageOverview"]}/>);
  expect(screen.queryByTestId("quality")).toBeNull();
  expect(loadingCard.mounts).toBe(0);
  expect(screen.getByTestId("usage")).toBeInTheDocument();
});
