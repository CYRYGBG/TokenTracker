import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, it, expect, vi } from "vitest";
import { ForkScope } from "./ForkScope";
import { forkApi } from "../lib/fork-api";
import { FORK_SYNC_CHANGED_EVENT } from "../lib/fork-sync-status";
vi.mock("../lib/fork-api", () => ({ forkApi: vi.fn() }));
vi.mock("../lib/copy", () => ({
  copy: (key, args) => key + (args ? JSON.stringify(args) : ""),
}));
beforeEach(() => vi.clearAllMocks());
it("clears a stale failure banner immediately after manual sync completes", async () => {
  forkApi
    .mockResolvedValueOnce({
      partial: true,
      last_failure: { code: "WEBDAV_TIMEOUT", timeout_ms: 30000 },
    })
    .mockResolvedValue({ partial: false });
  render(
    <MemoryRouter>
      <ForkScope />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "fork.sync.timeout_seconds",
  );
  await act(async () =>
    window.dispatchEvent(new Event(FORK_SYNC_CHANGED_EVENT)),
  );
  await waitFor(() =>
    expect(screen.queryByRole("status")).not.toBeInTheDocument(),
  );
});
it("does not let an older status response restore a failure after success", async () => {
  let finish;
  forkApi
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    )
    .mockResolvedValue({ partial: false });
  render(
    <MemoryRouter>
      <ForkScope />
    </MemoryRouter>,
  );
  await act(async () =>
    window.dispatchEvent(new Event(FORK_SYNC_CHANGED_EVENT)),
  );
  await act(async () =>
    finish({ partial: true, last_failure: { code: "WEBDAV_TIMEOUT" } }),
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
