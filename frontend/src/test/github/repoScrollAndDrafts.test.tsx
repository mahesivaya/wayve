// Code Repo on return from another page: scroll offsets are put back once the
// content is tall enough for them, and half-written comments come back with them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { CommitPatch, type LineComments } from "../../github/commitDiff";
import { DiffComment } from "../../github/GitHubRepo";
import {
  draftStore,
  forgetOpenRepo,
  readDraft,
  readRepoScrolls,
  readRepoView,
  rememberRepoScrolls,
  rememberRepoView,
  type RepoView,
} from "../../github/openRepoSession";
import { useRepoScroll } from "../../github/useRepoScroll";

const USER = 1;
const FULL = "acme/app";
const PANEL = ".github-content > .github-panel";

// A scroller as a browser treats it: scrollTop can't pass what the content allows.
let maxScroll = 0;
const clampScroll = (el: HTMLElement) => {
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.min(value, maxScroll);
    },
  });
};

function Page({ place = "commits" }: { place?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready] = useState(true);
  useRepoScroll({
    containerRef,
    userId: USER,
    fullName: FULL,
    place,
    file: null,
    ready,
  });
  return (
    <div className="github-content" ref={containerRef}>
      <div
        className="github-panel"
        data-testid="panel"
        ref={(el) => {
          if (el) clampScroll(el);
        }}
      />
    </div>
  );
}

describe("scroll position", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
    maxScroll = 5000;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const scrollTo = (top: number) => {
    const panel = screen.getByTestId("panel");
    panel.scrollTop = top;
    fireEvent.scroll(panel);
  };
  const offset = (place: string) =>
    readRepoScrolls(USER, FULL)[`place:${place}|${PANEL}`];

  it("remembers a scroll even when the page is left at once", () => {
    render(<Page />);
    scrollTo(800);
    expect(offset("commits")).toBeUndefined();
    cleanup();
    expect(offset("commits")).toBe(800);
  });

  it("puts it back on return", () => {
    rememberRepoScrolls(USER, FULL, { [`place:commits|${PANEL}`]: 800 });
    render(<Page />);
    expect(screen.getByTestId("panel").scrollTop).toBe(800);
  });

  it("waits for the content to be tall enough, without saving the partial offset", () => {
    rememberRepoScrolls(USER, FULL, { [`place:commits|${PANEL}`]: 800 });
    maxScroll = 100;
    render(<Page />);
    const panel = screen.getByTestId("panel");
    expect(panel.scrollTop).toBe(100);

    // The browser reports the clamped offset as a scroll; it isn't the user's.
    fireEvent.scroll(panel);
    act(() => void vi.advanceTimersByTime(300));
    expect(offset("commits")).toBe(800);

    maxScroll = 5000;
    act(() => void vi.advanceTimersByTime(100));
    expect(panel.scrollTop).toBe(800);
  });

  it("lets the user take over from a restore still in progress", () => {
    rememberRepoScrolls(USER, FULL, { [`place:commits|${PANEL}`]: 800 });
    maxScroll = 100;
    render(<Page />);
    fireEvent.wheel(document.body);
    maxScroll = 5000;
    act(() => void vi.advanceTimersByTime(500));
    expect(screen.getByTestId("panel").scrollTop).toBe(100);

    // And what they scroll to next is what's kept.
    scrollTo(40);
    act(() => void vi.advanceTimersByTime(200));
    expect(offset("commits")).toBe(40);
  });

  it("gives up if the content never gets there, and stays out of the way", () => {
    rememberRepoScrolls(USER, FULL, { [`place:commits|${PANEL}`]: 800 });
    maxScroll = 100;
    render(<Page />);
    act(() => void vi.advanceTimersByTime(9000));
    maxScroll = 5000;
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByTestId("panel").scrollTop).toBe(100);
  });

  it("keeps each place's offset apart", () => {
    rememberRepoScrolls(USER, FULL, { [`place:pulls#7|${PANEL}`]: 300 });
    const { rerender } = render(<Page place="commits" />);
    expect(screen.getByTestId("panel").scrollTop).toBe(0);
    rerender(<Page place="pulls#7" />);
    expect(screen.getByTestId("panel").scrollTop).toBe(300);
  });

  it("ignores scrolling elsewhere on the page", () => {
    render(<Page />);
    const outside = document.createElement("div");
    outside.className = "github-description";
    document.body.append(outside);
    fireEvent.scroll(outside);
    cleanup();
    outside.remove();
    expect(readRepoScrolls(USER, FULL)).toEqual({});
  });

  it("keeps only the most recent places", () => {
    const offsets = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`place:p${i}|${PANEL}`, i + 1])
    );
    rememberRepoScrolls(USER, FULL, offsets);
    const kept = readRepoScrolls(USER, FULL);
    expect(Object.keys(kept)).toHaveLength(50);
    expect(kept[`place:p59|${PANEL}`]).toBe(60);
  });
});

describe("half-written comments", () => {
  const KEY = `${FULL}|commit:abc:src/a.ts`;
  const PATCH = ["@@ -1,1 +1,1 @@", "-old", "+new", " tail"].join("\n");
  const box = () =>
    screen.getByRole("textbox", {
      name: "Leave a code comment",
    }) as HTMLTextAreaElement;

  const comments = (post = vi.fn(async () => {})): LineComments => ({
    comments: [],
    post,
    renderComment: () => null,
    draft: draftStore(USER, KEY),
  });

  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  it("reopens a line comment on its line with its text", () => {
    const { unmount } = render(
      <CommitPatch patch={PATCH} lineComments={comments()} />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Comment on line 1" })[1]
    );
    fireEvent.change(box(), { target: { value: "half written" } });
    unmount();

    render(<CommitPatch patch={PATCH} lineComments={comments()} />);
    expect(box().value).toBe("half written");
    expect(readDraft(USER, KEY)?.anchor).toEqual({
      side: "RIGHT",
      line: 1,
      position: 2,
    });
  });

  it("forgets it once posted", async () => {
    render(<CommitPatch patch={PATCH} lineComments={comments()} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Comment on line 1" })[1]
    );
    fireEvent.change(box(), { target: { value: "done" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(readDraft(USER, KEY)).toBeNull());
  });

  it("keeps it when posting fails", async () => {
    const post = vi.fn(async () => {
      throw new Error("nope");
    });
    render(<CommitPatch patch={PATCH} lineComments={comments(post)} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Comment on line 1" })[1]
    );
    fireEvent.change(box(), { target: { value: "try again" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    await screen.findByRole("alert");
    expect(readDraft(USER, KEY)?.body).toBe("try again");
  });

  it("forgets it when closed on purpose", () => {
    render(<CommitPatch patch={PATCH} lineComments={comments()} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Comment on line 1" })[1]
    );
    fireEvent.change(box(), { target: { value: "never mind" } });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(readDraft(USER, KEY)).toBeNull();
  });

  it("doesn't carry the text to another line", () => {
    render(<CommitPatch patch={PATCH} lineComments={comments()} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Comment on line 1" })[1]
    );
    fireEvent.change(box(), { target: { value: "for line one" } });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Comment on line 2" })[1]
    );
    expect(box().value).toBe("");
    expect(readDraft(USER, KEY)).toBeNull();
  });

  describe("an edit in progress", () => {
    const comment = {
      id: 9,
      user: { login: "dev" },
      body: "original",
      created_at: "2026-11-03T00:00:00Z",
    };
    const store = () => draftStore(USER, `${FULL}|edit:commit:9`);

    it("comes back, and closing it returns to the original", () => {
      const { unmount } = render(
        <DiffComment comment={comment} onSave={vi.fn()} editDraft={store()} />
      );
      fireEvent.click(screen.getByRole("button", { name: "Comment options" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
      fireEvent.change(box(), { target: { value: "reworded" } });
      unmount();

      render(
        <DiffComment comment={comment} onSave={vi.fn()} editDraft={store()} />
      );
      expect(box().value).toBe("reworded");

      fireEvent.keyDown(box(), { key: "Escape" });
      expect(screen.getByText("original")).toBeTruthy();
      expect(store().read()).toBeNull();
    });

    it("is forgotten once saved", async () => {
      const onSave = vi.fn(async () => {});
      render(
        <DiffComment comment={comment} onSave={onSave} editDraft={store()} />
      );
      fireEvent.click(screen.getByRole("button", { name: "Comment options" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
      fireEvent.change(box(), { target: { value: "saved" } });
      fireEvent.keyDown(box(), { key: "Enter" });
      await waitFor(() => expect(onSave).toHaveBeenCalledWith("saved"));
      await waitFor(() => expect(store().read()).toBeNull());
    });
  });
});

describe("the session entry", () => {
  const view: RepoView = {
    branch: "main",
    pull: null,
    file: null,
    folders: [],
    commits: [],
    commitsPage: 3,
    pullsPage: 2,
    collapsedFiles: ["abc::a.ts"],
    openPullFiles: ["pr-7::a.ts"],
    commitDrafts: { abc: "half", def: "" },
    pullDrafts: { "7": "written" },
  };

  beforeEach(() => sessionStorage.clear());

  it("keeps drafts, scrolls and views apart when any one changes", () => {
    draftStore(USER, "k").save({ body: "draft" });
    rememberRepoScrolls(USER, FULL, { a: 5 });
    rememberRepoView(USER, FULL, view);
    draftStore(USER, "other").save({ body: "more" });

    expect(readDraft(USER, "k")?.body).toBe("draft");
    expect(readRepoScrolls(USER, FULL)).toEqual({ a: 5 });
    expect(readRepoView(USER, FULL)?.commitsPage).toBe(3);
  });

  it("returns the view's places, dropping conversation drafts already cleared", () => {
    expect(
      (rememberRepoView(USER, FULL, view), readRepoView(USER, FULL))
    ).toMatchObject({
      pullsPage: 2,
      collapsedFiles: ["abc::a.ts"],
      openPullFiles: ["pr-7::a.ts"],
      commitDrafts: { abc: "half" },
      pullDrafts: { "7": "written" },
    });
  });

  it("is another user's to read only by that user, and forgotten at logout", () => {
    draftStore(USER, "k").save({ body: "private" });
    rememberRepoScrolls(USER, FULL, { a: 5 });
    expect(readDraft(2, "k")).toBeNull();
    expect(readRepoScrolls(2, FULL)).toEqual({});

    forgetOpenRepo();
    expect(readDraft(USER, "k")).toBeNull();
    expect(readRepoScrolls(USER, FULL)).toEqual({});
  });

  it("survives wrong-shaped storage", () => {
    sessionStorage.setItem(
      "rwayve.github.open",
      JSON.stringify({
        userId: USER,
        drafts: { a: { body: 4 }, b: { body: "ok", anchor: { side: "UP" } } },
        scrolls: { [FULL]: { a: "far", b: 7 } },
        views: { [FULL]: { commitsPage: -2, commitDrafts: { x: 1 } } },
      })
    );
    expect(readDraft(USER, "a")).toBeNull();
    expect(readDraft(USER, "b")).toEqual({ body: "ok" });
    expect(readRepoScrolls(USER, FULL)).toEqual({ b: 7 });
    expect(readRepoView(USER, FULL)).toMatchObject({
      commitsPage: 1,
      commitDrafts: {},
    });
  });
});
