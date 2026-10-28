import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ForkSyncSection from "./ForkSyncPage.jsx";

const forkApiMock = vi.hoisted(() => vi.fn());
const saveLocalUsageExportMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/fork-api", () => ({
  forkApi: forkApiMock,
}));

vi.mock("../lib/native-bridge", () => ({
  saveLocalUsageExport: saveLocalUsageExportMock,
}));

const statusResponse = {
  config: {
    url: "https://dav.jianguoyun.com/dav",
    username: "user@example.com",
    directory: "tokentracker-fork",
    device_name: "Mac",
    enabled: true,
    sync_titles: true,
    interval_minutes: 5,
  },
  credential_present: true,
  machine_id: "local-machine",
  device_names: { "966d21f43dde8b9153b1e5b4725981f9b7dfbe923330d632b6fc689804ff9152c": "Windows" },
  sync: {
    last_success_at: "2026-10-28T04:52:44.759Z",
    last_failure: null,
    backoff_until_ms: 0,
    paused_auth: false,
    docs: {},
    imported: {
      "966d21f43dde8b9153b1e5b4725981f9b7dfbe923330d632b6fc689804ff9152c": { ok: true, updated: false },
    },
    notes: [],
  },
};

function primeApi(overrides = {}) {
  forkApiMock.mockImplementation(async (path, init) => {
    if (path === "/api/webdav/status") {
      return { ...statusResponse, ...overrides.status, sync: { ...statusResponse.sync, ...overrides.sync } };
    }
    if (path === "/api/fork/prefs") return { expenses: [], prices: [], aliases: {} };
    if (path === "/api/fork/pricing") return { source: null, version: null, updated_at: null };
    throw new Error(`unexpected forkApi call: ${path} ${init?.method ?? "GET"}`);
  });
}

function renderSection() {
  return render(<ForkSyncSection />);
}

describe("ForkSyncSection", () => {
  beforeEach(() => {
    forkApiMock.mockReset();
    saveLocalUsageExportMock.mockReset();
    primeApi();
  });

  it("locks every credential field until Edit is clicked", async () => {
    renderSection();
    await waitFor(() => expect(screen.getByLabelText("Server URL")).toHaveProperty("readOnly", true));
    expect(screen.getByLabelText("Username")).toHaveProperty("readOnly", true);
    expect(screen.getByLabelText("Device name")).toHaveProperty("readOnly", true);
    expect(screen.getByLabelText("App password")).toHaveProperty("readOnly", true);
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Server URL")).toHaveProperty("readOnly", false);
    expect(screen.getByLabelText("App password")).toHaveProperty("readOnly", false);
  });

  it("locks the toggles and the interval select until Edit is clicked", async () => {
    renderSection();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Background sync" })).toBeDisabled());
    expect(screen.getByLabelText("Sync interval")).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Sync session titles" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("switch", { name: "Background sync" })).toBeEnabled();
    expect(screen.getByLabelText("Sync interval")).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Sync session titles" })).toBeEnabled();
  });

  it("offers minute and hour interval presets and keeps an off-preset saved value selectable", async () => {
    const first = renderSection();
    const select = await screen.findByLabelText("Sync interval");
    expect([...select.options].map((option) => option.textContent)).toEqual(
      ["5 min", "15 min", "30 min", "1 hr", "2 hr", "6 hr", "12 hr", "24 hr"],
    );
    first.unmount();

    primeApi({ status: { config: { ...statusResponse.config, interval_minutes: 90 } } });
    renderSection();
    const rerendered = await screen.findByLabelText("Sync interval");
    expect([...rerendered.options].map((option) => option.value)).toContain("90");
    expect(rerendered).toHaveValue("90");
  });

  it("saves and tests from the edit state, then re-locks", async () => {
    forkApiMock.mockImplementation(async (path, init) => {
      if (path === "/api/webdav/status") return statusResponse;
      if (path === "/api/fork/prefs") return { expenses: [], prices: [], aliases: {} };
      if (path === "/api/fork/pricing") return { source: null, version: null, updated_at: null };
      if (path === "/api/webdav/config" && init?.method === "PUT") return {};
      if (path === "/api/webdav/test" && init?.method === "POST") return {};
      throw new Error(`unexpected forkApi call: ${path}`);
    });
    renderSection();
    await screen.findByLabelText("Server URL");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://dav.example.com/dav" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and test connection" }));

    await waitFor(() => expect(forkApiMock).toHaveBeenCalledWith("/api/webdav/test", { method: "POST" }));
    await waitFor(() => {
      const putCall = forkApiMock.mock.calls.find(([path, init]) => path === "/api/webdav/config" && init?.method === "PUT");
      expect(putCall[1].body.interval_minutes).toBe(5);
      expect(putCall[1].body.url).toBe("https://dav.example.com/dav");
    });
    // Back to the locked state: Edit is offered again, Save and test is not.
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save and test connection" })).toBeNull();
    expect(screen.getByLabelText("Server URL")).toHaveProperty("readOnly", true);
  });

  it("Cancel discards edits and re-locks without saving", async () => {
    renderSection();
    await screen.findByLabelText("Server URL");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://broken.example/dav" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByLabelText("Server URL")).toHaveValue("https://dav.jianguoyun.com/dav");
    expect(screen.getByLabelText("Server URL")).toHaveProperty("readOnly", true);
    expect(forkApiMock).not.toHaveBeenCalledWith("/api/webdav/config", expect.anything());
  });

  it("shows the last sync time to minute precision and device names instead of machine ids", async () => {
    renderSection();
    // Rendered in the machine's local zone; assert shape (date + HH:mm, no seconds, no Z).
    const statusLine = await screen.findByText("Last successful sync:", { exact: false });
    expect(statusLine.textContent).toMatch(/Last successful sync: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(screen.getByText("Windows：Synced")).toBeInTheDocument();
    expect(screen.queryByText(/966d21f4/)).toBeNull();
  });

  it("reports a failed last sync as its own line with the failure code", async () => {
    primeApi({
      sync: {
        last_failure: { code: "WEBDAV_UPLOAD_FAILED", message: "boom" },
      },
    });
    renderSection();
    await screen.findByText("Last successful sync:", { exact: false });
    expect(screen.getByText(/Last sync failed \(WEBDAV_UPLOAD_FAILED\)/)).toBeInTheDocument();
  });
});
