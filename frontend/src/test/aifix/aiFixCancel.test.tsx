// A fix that is queued or running can be canceled from the panel. Afterwards
// the item says so and can be started again; a fix with a result to review has
// nothing to cancel.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AiFixPanel from "../../aifix/AiFixPanel";
import type { AiFixApi, AiFixState, AiFixStatus } from "../../api/aiFix";

const stateOf = (status: AiFixStatus | null): AiFixState => ({
  status,
  diff: null,
  files: [],
  commit_sha: null,
  branch: null,
  pr_url: null,
  progress: status === "running" || status === "queued" ? 20 : null,
  step: status === "running" ? "Claude is reading the code" : null,
});

// The server's state follows what the panel does to it, like the real one.
const makeApi = (initial: AiFixStatus | null, canceled = true) => {
  let status = initial;
  const api: AiFixApi = {
    getState: vi.fn(() => Promise.resolve(stateOf(status))),
    start: vi.fn().mockResolvedValue({ reused_fix_from: null }),
    cancel: vi.fn(() => {
      if (canceled) status = "canceled";
      return Promise.resolve({ canceled });
    }),
    saveEdits: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
    openPr: vi.fn(),
  };
  return {
    api,
    finish: (next: AiFixStatus) => {
      status = next;
    },
  };
};

const renderPanel = (api: AiFixApi) =>
  render(<AiFixPanel itemId={7} api={api} canFix kind="story" />);

describe("canceling an AI fix", () => {
  it.each(["running", "queued"] as const)(
    "offers Cancel while the fix is %s and stops it",
    async (status) => {
      const { api } = makeApi(status);
      renderPanel(api);
      const cancel = await screen.findByRole("button", { name: "Cancel" });

      fireEvent.click(cancel);
      await waitFor(() => expect(api.cancel).toHaveBeenCalledWith(7));

      // The panel now reads as canceled: no progress bar, no Cancel, and the
      // fix can be started again.
      expect(
        await screen.findByText(/was canceled before it finished/)
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
      expect(screen.queryByRole("progressbar")).toBeNull();
      expect(screen.getByRole("button", { name: "Fix with AI" })).toBeTruthy();
    }
  );

  it("shows the result when the run finished just before the cancel", async () => {
    const { api, finish } = makeApi("running", false);
    renderPanel(api);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    // The run ends between the last poll and the click.
    finish("no_change");
    fireEvent.click(cancel);

    expect(await screen.findByText(/nothing to cancel/)).toBeTruthy();
    expect(await screen.findByText(/proposed no code change/)).toBeTruthy();
    expect(screen.queryByText(/was canceled before it finished/)).toBeNull();
  });

  it("has no Cancel when there is nothing running", async () => {
    const { api } = makeApi("no_change");
    renderPanel(api);
    await screen.findByRole("button", { name: "Retry AI fix" });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
