// Code Repo diffs: commenting on a line, and the anchors GitHub needs for it.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CommitPatch, type LineComments } from "../../github/commitDiff";
import { DiffComment } from "../../github/GitHubRepo";
import { DEFAULT_DIFF_PREFS } from "../../github/diffPrefs";
import type { IssueComment } from "../../github/commitDiffData";

// Positions count from the line under the first header, later headers included:
// keep=1, old=2, new=3, header=4, tail=5.
const PATCH = [
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "@@ -40,1 +40,1 @@",
  " tail",
].join("\n");

const UNIFIED = { ...DEFAULT_DIFF_PREFS, layout: "unified" as const };

const comment = (fields: Partial<IssueComment>): IssueComment => ({
  id: 1,
  user: { login: "dev" },
  body: "a comment",
  created_at: "2026-11-03T00:00:00Z",
  ...fields,
});

const setup = (
  comments: IssueComment[] = [],
  post: LineComments["post"] = async () => {}
): LineComments => ({
  comments,
  post,
  renderComment: (c) => <li>{c.body}</li>,
});

const composer = () =>
  screen.queryByRole("textbox", { name: "Leave a code comment" });

const openAndPost = async (line: number, text: string) => {
  fireEvent.click(
    screen.getAllByRole("button", { name: `Comment on line ${line}` })[0]
  );
  fireEvent.change(composer()!, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
};

describe("commenting on a diff line", () => {
  it("offers nothing when the diff can't take comments", () => {
    render(<CommitPatch patch={PATCH} prefs={UNIFIED} />);
    expect(
      screen.queryByRole("button", { name: /Comment on line/ })
    ).toBeNull();
  });

  it("offers each line once in unified, numbered by its own side", () => {
    render(
      <CommitPatch patch={PATCH} prefs={UNIFIED} lineComments={setup()} />
    );
    const names = screen
      .getAllByRole("button", { name: /Comment on line/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Comment on line 1",
      "Comment on line 2",
      "Comment on line 2",
      "Comment on line 40",
    ]);
  });

  it("posts a removal on the old side and an addition on the new", async () => {
    const post = vi.fn(async () => {});
    render(
      <CommitPatch
        patch={PATCH}
        prefs={UNIFIED}
        lineComments={setup([], post)}
      />
    );
    const [removed, added] = screen.getAllByRole("button", {
      name: "Comment on line 2",
    });

    fireEvent.click(removed);
    fireEvent.change(composer()!, { target: { value: "on old" } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(composer()).toBeNull());
    expect(post).toHaveBeenLastCalledWith(
      { side: "LEFT", line: 2, position: 2 },
      "on old"
    );

    fireEvent.click(added);
    fireEvent.change(composer()!, { target: { value: "on new" } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(composer()).toBeNull());
    expect(post).toHaveBeenLastCalledWith(
      { side: "RIGHT", line: 2, position: 3 },
      "on new"
    );
  });

  it("counts later hunk headers in the position", async () => {
    const post = vi.fn(async () => {});
    render(
      <CommitPatch
        patch={PATCH}
        prefs={UNIFIED}
        lineComments={setup([], post)}
      />
    );
    await openAndPost(40, "  on tail ");
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(
      { side: "RIGHT", line: 40, position: 5 },
      "on tail"
    );
  });

  it("counts a no-newline marker in the position", async () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
    ].join("\n");
    const post = vi.fn(async () => {});
    render(
      <CommitPatch
        patch={patch}
        prefs={UNIFIED}
        lineComments={setup([], post)}
      />
    );
    const [, added] = screen.getAllByRole("button", {
      name: "Comment on line 1",
    });
    fireEvent.click(added);
    fireEvent.change(composer()!, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(
      { side: "RIGHT", line: 1, position: 3 },
      "x"
    );
  });

  it("anchors each side of a split row to its own line", async () => {
    const post = vi.fn(async () => {});
    render(<CommitPatch patch={PATCH} lineComments={setup([], post)} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Comment on line 2" })[0]
    );
    fireEvent.change(composer()!, { target: { value: "split" } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(
      { side: "LEFT", line: 2, position: 2 },
      "split"
    );
  });

  it("doesn't offer lines revealed from the full file", async () => {
    const file = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    render(
      <CommitPatch
        patch={PATCH}
        prefs={UNIFIED}
        loadLines={async () => file}
        lineComments={setup()}
      />
    );
    fireEvent.click(screen.getByText("37 unchanged lines"));
    await waitFor(() =>
      expect(screen.queryByText("37 unchanged lines")).toBeNull()
    );
    expect(screen.getByText(/line 20/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Comment on line 20" })
    ).toBeNull();
  });

  it("keeps the draft and shows the error when posting fails", async () => {
    const post = vi.fn(async () => {
      throw new Error("You don't have access");
    });
    render(
      <CommitPatch
        patch={PATCH}
        prefs={UNIFIED}
        lineComments={setup([], post)}
      />
    );
    await openAndPost(40, "keep me");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "You don't have access"
    );
    expect((composer() as HTMLTextAreaElement).value).toBe("keep me");
  });

  it("closes from the X and from Escape, and won't post an empty comment", () => {
    render(
      <CommitPatch patch={PATCH} prefs={UNIFIED} lineComments={setup()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 40" }));
    expect(
      (
        screen.getByRole("button", {
          name: "Post comment",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close comment" }));
    expect(composer()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Comment on line 40" }));
    fireEvent.keyDown(composer()!, { key: "Escape" });
    expect(composer()).toBeNull();
  });

  it("posts with Enter and leaves Shift+Enter to start a new line", async () => {
    const post = vi.fn(async () => {});
    render(
      <CommitPatch
        patch={PATCH}
        prefs={UNIFIED}
        lineComments={setup([], post)}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 40" }));

    // Enter on an empty box does nothing, and doesn't add a blank line.
    expect(fireEvent.keyDown(composer()!, { key: "Enter" })).toBe(false);
    expect(post).not.toHaveBeenCalled();

    fireEvent.change(composer()!, { target: { value: "quick" } });
    // Not prevented, so the browser inserts the newline.
    expect(
      fireEvent.keyDown(composer()!, { key: "Enter", shiftKey: true })
    ).toBe(true);
    expect(post).not.toHaveBeenCalled();

    // Enter while an IME is composing picks a candidate rather than sending.
    fireEvent.keyDown(composer()!, { key: "Enter", isComposing: true });
    expect(post).not.toHaveBeenCalled();

    fireEvent.keyDown(composer()!, { key: "Enter" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });
});

describe("editing a comment", () => {
  const editBox = () =>
    screen.getByRole("textbox", {
      name: "Leave a code comment",
    }) as HTMLTextAreaElement;

  const startEditing = () => {
    fireEvent.click(screen.getByRole("button", { name: "Comment options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  };

  it("opens with the comment's text and saves the change", async () => {
    const onSave = vi.fn(async () => {});
    render(
      <DiffComment comment={comment({ body: "first" })} onSave={onSave} />
    );
    startEditing();
    expect(editBox().value).toBe("first");
    expect(document.querySelector(".github-pr-comment-text")).toBeNull();

    fireEvent.change(editBox(), { target: { value: "second" } });
    fireEvent.keyDown(editBox(), { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("second"));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("doesn't call GitHub when nothing changed", async () => {
    const onSave = vi.fn(async () => {});
    render(<DiffComment comment={comment({ body: "same" })} onSave={onSave} />);
    startEditing();
    fireEvent.keyDown(editBox(), { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("same")).toBeTruthy();
  });

  it("keeps the edit open with the reason when the server refuses", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("You can only edit your own comments");
    });
    render(
      <DiffComment comment={comment({ body: "theirs" })} onSave={onSave} />
    );
    startEditing();
    fireEvent.change(editBox(), { target: { value: "mine now" } });
    fireEvent.keyDown(editBox(), { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "your own comments"
    );
    expect(editBox().value).toBe("mine now");
  });

  it("cancels back to the original text", () => {
    render(
      <DiffComment comment={comment({ body: "kept" })} onSave={vi.fn()} />
    );
    startEditing();
    fireEvent.change(editBox(), { target: { value: "dropped" } });
    fireEvent.keyDown(editBox(), { key: "Escape" });
    expect(screen.getByText("kept")).toBeTruthy();
  });

  it("closes the menu from Escape and from a click elsewhere", () => {
    render(<DiffComment comment={comment({})} onSave={vi.fn()} />);
    const options = screen.getByRole("button", { name: "Comment options" });
    fireEvent.click(options);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(options);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("threads on a diff line", () => {
  it("places a commit comment by its position", () => {
    render(
      <CommitPatch
        patch={PATCH}
        prefs={UNIFIED}
        lineComments={setup([comment({ position: 3 })])}
      />
    );
    const thread = screen.getByText("a comment").closest(".github-line-thread");
    expect(thread?.previousElementSibling?.textContent).toContain("new");
  });

  it("places a pull request comment by its side and line", () => {
    render(
      <CommitPatch
        patch={PATCH}
        prefs={UNIFIED}
        lineComments={setup([comment({ side: "LEFT", line: 2 })])}
      />
    );
    const thread = screen.getByText("a comment").closest(".github-line-thread");
    expect(thread?.previousElementSibling?.textContent).toContain("old");
  });

  it("shows a comment once on a context line, whichever side it was on", () => {
    render(
      <CommitPatch
        patch={PATCH}
        lineComments={setup([comment({ side: "RIGHT", line: 1 })])}
      />
    );
    expect(screen.getAllByText("a comment")).toHaveLength(1);
  });

  it("leaves out an outdated pull request comment", () => {
    render(
      <CommitPatch
        patch={PATCH}
        prefs={UNIFIED}
        lineComments={setup([
          comment({ side: "RIGHT", line: null, position: null }),
        ])}
      />
    );
    expect(screen.queryByText("a comment")).toBeNull();
  });
});
