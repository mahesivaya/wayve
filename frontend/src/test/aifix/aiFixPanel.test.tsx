// The shared AI-fix panel: what a developer sees after clicking an item. It has
// to show the diff and the Commit button inline (no navigation), let them edit
// the proposed file contents, and hide the whole thing for priorities that
// aren't eligible.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AiFixPanel from "../../aifix/AiFixPanel";
import { decodeContent, encodeContent } from "../../aifix/diff";
import type { AiFixApi, AiFixState } from "../../api/aiFix";

const READY: AiFixState = {
  status: "ready",
  diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old line\n+new line",
  files: [{ path: "src/a.ts", content: encodeContent("new line\n"), deleted: false }],
  commit_sha: null,
  branch: null,
  pr_url: null,
};

// "No run yet" is a resolved empty state — distinct from a failed read, which
// the panel now reports rather than passing off as "nothing here".
const EMPTY: AiFixState = {
  status: null,
  diff: null,
  files: [],
  commit_sha: null,
  branch: null,
  pr_url: null,
};

const makeApi = (state: AiFixState = EMPTY): AiFixApi => ({
  getState: vi.fn().mockResolvedValue(state),
  start: vi.fn().mockResolvedValue({ reused_fix_from: null }),
  saveEdits: vi.fn().mockResolvedValue({ saved: true }),
  commit: vi.fn().mockResolvedValue({ commit_sha: "abc1234def" }),
  push: vi.fn().mockResolvedValue({ branch: "ai-fix/ticket-1-abc1234" }),
  openPr: vi.fn().mockResolvedValue({ pr_url: "https://github.com/x/y/pull/1" }),
});

describe("base64 round-trip", () => {
  // btoa/atob are latin1-only, so a naive implementation corrupts any non-ASCII
  // source file the moment it is saved.
  it("survives non-ASCII content", () => {
    const text = "const s = “héllo” // ✨\n";
    expect(decodeContent(encodeContent(text))).toBe(text);
  });

  it("decodes malformed base64 to empty rather than throwing", () => {
    expect(decodeContent("!!!not base64!!!")).toBe("");
  });
});

describe("AiFixPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders nothing when the priority is not eligible and no run exists", async () => {
    const api = makeApi();
    const { container } = render(
      <AiFixPanel itemId={1} api={api} canFix={false} />
    );
    await waitFor(() => expect(api.getState).toHaveBeenCalled());
    expect(container.querySelector(".aifix")).toBeNull();
  });

  // Regression: a 403 on the read used to look exactly like "no fix yet", so a
  // reviewed diff sitting on the row silently never appeared.
  it("reports a failed read instead of looking empty", async () => {
    const api = makeApi();
    (api.getState as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("forbidden")
    );
    render(<AiFixPanel itemId={1} api={api} canFix={false} />);
    expect(await screen.findByText(/Couldn’t load the AI fix/)).toBeTruthy();
    expect(screen.getByText(/forbidden/)).toBeTruthy();
  });

  it("offers Fix with AI when the priority is eligible", async () => {
    render(<AiFixPanel itemId={1} api={makeApi()} canFix />);
    expect(
      await screen.findByRole("button", { name: /Fix with AI/ })
    ).toBeTruthy();
  });

  it("shows the diff and the Commit button inline once CI reports back", async () => {
    render(<AiFixPanel itemId={1} api={makeApi(READY)} canFix />);

    // The diff is on screen without navigating anywhere.
    expect(await screen.findByText("+new line")).toBeTruthy();
    expect(screen.getByText("-old line")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Commit" })).toBeTruthy();
    // Push/PR stay locked until Commit lands.
    expect(
      (screen.getByRole("button", { name: "Push" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("saves an edited file as re-encoded base64", async () => {
    const api = makeApi(READY);
    render(<AiFixPanel itemId={7} api={api} canFix />);

    fireEvent.click(await screen.findByRole("button", { name: /src\/a\.ts/ }));
    const editor = screen.getByLabelText(
      "Contents of src/a.ts"
    ) as HTMLTextAreaElement;
    expect(editor.value).toBe("new line\n");

    fireEvent.change(editor, { target: { value: "developer edit\n" } });
    fireEvent.click(
      await screen.findByRole("button", { name: /Save 1 edited file/ })
    );

    await waitFor(() => expect(api.saveEdits).toHaveBeenCalled());
    const [id, files] = (api.saveEdits as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(id).toBe(7);
    expect(decodeContent(files[0].content)).toBe("developer edit\n");
  });

  it("advances through Commit → Push → Create PR", async () => {
    const api = makeApi(READY);
    render(<AiFixPanel itemId={1} api={api} canFix />);

    fireEvent.click(await screen.findByRole("button", { name: "Commit" }));
    await waitFor(() => expect(api.commit).toHaveBeenCalledWith(1));

    fireEvent.click(await screen.findByRole("button", { name: "Push" }));
    await waitFor(() => expect(api.push).toHaveBeenCalledWith(1));

    fireEvent.click(await screen.findByRole("button", { name: "Create PR" }));
    await waitFor(() => expect(api.openPr).toHaveBeenCalledWith(1));
    expect(await screen.findByText(/View pull request/)).toBeTruthy();
  });

  it("does not offer editing once the fix is committed", async () => {
    render(
      <AiFixPanel
        itemId={1}
        api={makeApi({ ...READY, status: "committed", commit_sha: "abc1234" })}
        canFix
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: /src\/a\.ts/ }));
    const editor = screen.getByLabelText(
      "Contents of src/a.ts"
    ) as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
  });
});
