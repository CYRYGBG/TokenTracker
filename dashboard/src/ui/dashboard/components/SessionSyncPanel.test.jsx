import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

// The panel is a thin view over /api/session-sync/*; these tests stub the
// transport and assert selection/upload/import flows and error rendering.

const mockLocal = {
  items: [
    { agent: "codex", sessionId: "s1", title: "Codex 对话", updatedAtMs: Date.parse("2026-11-14T02:00:00Z"), bytes: 2048, upload: null },
    { agent: "zcode", sessionId: "s2", title: null, updatedAtMs: Date.parse("2026-11-15T03:00:00Z"), bytes: 512, upload: { revision: 2, uploadedAt: "2026-11-15T03:10:00Z" } },
  ],
  imported: [],
};
const mockRemote = {
  fetchedAt: "2026-11-15T04:00:00Z",
  devices: {
    deviceA: {
      name: "Mac",
      platform: "darwin",
      sessions: [
        { agent: "codex", session_id: "s1", title: "接力对话", revision: 3, updated_at: "2026-11-14T05:00:00Z", bytes: 4096, imported: null },
        { agent: "antigravity", session_id: "s9", title: null, revision: 1, updated_at: "2026-11-13T05:00:00Z", bytes: 8192, imported: { revision: 1, importedAt: "2026-11-14T08:00:00Z", hasUpdate: false } },
      ],
    },
  },
};

const statusHandlers = {
  "/api/local-auth": () => ({ token: "test-token" }),
  "/api/session-sync/local": () => ({ items: mockLocal.items, imported: mockLocal.imported }),
  "/api/session-sync/remote": () => mockRemote,
  "/api/session-sync/status": () => ({ job: null, uploadedCount: 1, importedCount: 1, remoteFetchedAt: mockRemote.fetchedAt }),
  "/api/session-sync/upload": () => ({ ok: true, jobId: "job-1" }),
  "/api/session-sync/import": () => ({ ok: true, jobId: "job-2" }),
  "/api/session-sync/remote-refresh": () => ({ ok: true, fetchedAt: "2026-11-15T05:00:00Z", devices: mockRemote.devices }),
};

let fetchMock;

async function renderPanel() {
  const { SessionSyncPanel } = await import("./SessionSyncPanel.jsx");
  return render(<SessionSyncPanel />);
}

beforeEach(() => {
  fetchMock = vi.fn(async (path) => {
    const url = String(path);
    const handler = Object.entries(statusHandlers).find(([prefix]) => url.startsWith(prefix))?.[1];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return {
      ok: true,
      status: 200,
      json: async () => handler(),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SessionSyncPanel", () => {
  test("lists local conversations with agent, title fallback, and upload badge", async () => {
    await renderPanel();
    expect(await screen.findByText("Codex 对话")).toBeInTheDocument();
    expect(screen.getAllByText("(untitled)").length).toBeGreaterThan(0);
    expect(screen.getByText("Uploaded v2")).toBeInTheDocument();
    expect(screen.getByText("Conversations on this device")).toBeInTheDocument();
  });

  test("lists remote conversations grouped by device with imported badges", async () => {
    await renderPanel();
    expect(await screen.findByText("接力对话")).toBeInTheDocument();
    expect(screen.getByText("Imported v1")).toBeInTheDocument();
    // The fetched-at stamp renders in local time; assert the prefix only.
    expect(screen.getByText(/Last refreshed \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)).toBeInTheDocument();
  });

  test("upload button reflects the selection and posts the items", async () => {
    const user = userEvent.setup();
    await renderPanel();
    const checkbox = await screen.findByRole("checkbox", { name: "Codex 对话" });
    await user.click(checkbox);
    const uploadButton = screen.getByRole("button", { name: "Upload selected (1)" });
    await user.click(uploadButton);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([p]) => String(p).startsWith("/api/session-sync/upload"));
      expect(call).toBeTruthy();
    });
    const [, options] = fetchMock.mock.calls.find(([p]) => String(p).startsWith("/api/session-sync/upload"));
    expect(JSON.parse(options.body)).toEqual({ items: [{ agent: "codex", sessionId: "s1" }] });
  });

  test("import button posts device-scoped items", async () => {
    const user = userEvent.setup();
    await renderPanel();
    const checkbox = await screen.findByRole("checkbox", { name: "接力对话" });
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Sync to this device (1)" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([p]) => String(p).startsWith("/api/session-sync/import"));
      expect(call).toBeTruthy();
    });
    const [, options] = fetchMock.mock.calls.find(([p]) => String(p).startsWith("/api/session-sync/import"));
    expect(JSON.parse(options.body)).toEqual({ items: [{ device: "deviceA", agent: "codex", sessionId: "s1" }] });
  });

  test("structured error codes render the localized explanation, not raw errors", async () => {
    fetchMock.mockImplementation(async (path) => {
      const url = String(path);
      if (url.startsWith("/api/session-sync/upload")) {
        return { ok: false, status: 400, json: async () => ({ ok: false, code: "SESSION_SYNC_CONFLICT" }) };
      }
      const handler = Object.entries(statusHandlers).find(([prefix]) => url.startsWith(prefix))?.[1];
      return { ok: true, status: 200, json: async () => handler() };
    });
    const user = userEvent.setup();
    await renderPanel();
    await user.click(await screen.findByRole("checkbox", { name: "Codex 对话" }));
    await user.click(screen.getByRole("button", { name: "Upload selected (1)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed since the last sync");
  });

  test("a stale persisted job from a previous session never surfaces its errors", async () => {
    // Regression for the release-night incident: the backend keeps the last
    // job on disk for crash recovery, and the panel used to replay its
    // per-item errors on every visit as if it had just failed.
    fetchMock.mockImplementation(async (path) => {
      const url = String(path);
      if (url.startsWith("/api/session-sync/status")) {
        return { ok: true, status: 200, json: async () => ({
          job: {
            id: "job-old-1",
            type: "upload",
            state: "done-with-errors",
            startedAt: "2026-11-20T15:24:54.203Z",
            items: [{ agent: "codex", sessionId: "x", status: "error", code: "SESSION_SYNC_LOCAL_MISSING" }],
          },
          uploadedCount: 0, importedCount: 0, remoteFetchedAt: null,
        }) };
      }
      const handler = Object.entries(statusHandlers).find(([prefix]) => url.startsWith(prefix))?.[1];
      return { ok: true, status: 200, json: async () => handler() };
    });
    await renderPanel();
    expect(await screen.findByText("Codex 对话")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/conversation sync failed/i)).toBeNull();
  });
});
