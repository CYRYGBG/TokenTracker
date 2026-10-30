import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { it, expect, vi } from "vitest";
import App from "./App.jsx";
const TEXT = {
  scope: "Device scope",
  usage: "Local usage",
  sessions: "Session details",
  limits: "Provider limits",
  settings: "Local settings",
  sync: "WebDAV setup",
};
vi.mock("./ui/foundation/ThemeProvider.jsx", () => ({
  ThemeProvider: ({ children }) => <>{children}</>,
}));
vi.mock("./components/ForkScope.jsx", () => ({
  ForkScope: () => <span>{TEXT.scope}</span>,
}));
vi.mock("./ui/components/Sidebar.jsx", () => ({
  AppLayout: ({ children }) => <div>{children}</div>,
}));
vi.mock("./pages/DashboardPage.jsx", () => ({
  DashboardPage: () => <h1>{TEXT.usage}</h1>,
}));
vi.mock("./pages/SessionsPage.jsx", () => ({
  SessionsPage: () => <h1>{TEXT.sessions}</h1>,
}));
vi.mock("./pages/LimitsPage.jsx", () => ({
  LimitsPage: () => <h1>{TEXT.limits}</h1>,
}));
vi.mock('./pages/ReportsPage.jsx', () => ({ ReportsPage: () => <h1>{'Usage reports'}</h1> }));
vi.mock("./pages/SettingsPage.jsx", () => ({
  SettingsPage: () => <h1>{TEXT.settings}</h1>,
}));
vi.mock("./pages/ForkSyncPage.jsx", () => ({
  default: () => <h1>{TEXT.sync}</h1>,
}));
it.each([
  "/",
  "/login",
  "/cloud",
  "/leaderboard",
  "/skills",
  "/pet-settings",
  "/widgets",
])(
  "starts %s without official authentication or retired pages",
  async (route) => {
    render(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "Local usage" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Device scope")).toBeInTheDocument();
  },
);
it.each([
  ["/sessions", "Session details"],
  ["/limits", "Provider limits"],
  ['/reports', 'Usage reports'],
  ["/settings", "Local settings"],
  ["/devices?app=1", "Local settings"],
])("retains %s in the local shell", async (route, title) => {
  render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("heading", { name: title }),
  ).toBeInTheDocument();
});
