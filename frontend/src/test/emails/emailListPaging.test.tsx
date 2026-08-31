import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmailList } from "../../emails/EmailList";
import type { EmailItem } from "../../emails/types";

// jsdom ships no IntersectionObserver. The stub mirrors the one behaviour the
// paging logic depends on: observing a target always delivers an initial
// callback describing its current intersection.
let intersecting = true;

class StubIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: ReadonlyArray<number> = [];
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe() {
    this.callback(
      [{ isIntersecting: intersecting } as IntersectionObserverEntry],
      this
    );
  }

  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

// Controls whether the post-load geometry check in `triggerLoadMore` (see
// EmailList.tsx) reports the sentinel as still within the load margin. `near`
// makes every element's rect report a 0px gap; flipping it to `false` reports
// a 1000px gap, matching a pane that's now been filled.
let near = true;

function makeEmails(count: number): EmailItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    subject: `Subject ${index + 1}`,
    sender: `Sender ${index + 1} <s${index + 1}@example.com>`,
    created_at: "2026-08-06T10:00:00Z",
    is_read: true,
  }));
}

function renderList(props: {
  emails: EmailItem[];
  hasMore: boolean;
  loadMore: () => void | Promise<void>;
  loadingMore?: boolean;
}) {
  return render(
    <EmailList
      emails={props.emails}
      selectedEmailId={null}
      onOpenEmail={() => {}}
      hasMore={props.hasMore}
      loadMore={props.loadMore}
      loadingMore={props.loadingMore ?? false}
      activeFolder="inbox"
    />
  );
}

describe("EmailList paging", () => {
  beforeEach(() => {
    intersecting = true;
    near = true;
    vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
    // Run rAF callbacks synchronously so the post-load geometry check (which
    // real browsers defer to the next paint) resolves within `act()`.
    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: FrameRequestCallback): number => {
        cb(0);
        return 0;
      }
    );
    // jsdom performs no real layout, so every element's rect is zeros by
    // default — that already reads as "near" (a 0px gap). Overriding it lets
    // tests flip to "far" once a page should stop the cascade.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          top: near ? 0 : 1000,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON() {},
        }) as DOMRect
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps paging on its own while the pane is still short", async () => {
    // The regression this guards: a page lands but doesn't fill the visible
    // pane (sentinel still within the load margin) and nothing else asks
    // again — the list stalls with rows outstanding. `triggerLoadMore`'s
    // post-load geometry check must re-trigger itself without needing the
    // parent to hand back a bigger `emails` array.
    const loadMore = vi.fn(async () => {
      // Second page fills the pane — matches a real fetch's result changing
      // what geometry looks like once rendered.
      if (loadMore.mock.calls.length >= 2) near = false;
    });
    renderList({ emails: makeEmails(2), hasMore: true, loadMore });

    await act(async () => {});
    expect(loadMore).toHaveBeenCalledTimes(2);
  });

  it("stops asking once the server says there is nothing left", async () => {
    const loadMore = vi.fn(async () => {});
    renderList({ emails: makeEmails(2), hasMore: false, loadMore });

    await act(async () => {});
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("recovers when the parent rejects a load without flipping loadingMore", async () => {
    // `useEmailInbox.loadMore` returns early on its own guards, leaving
    // `loadingMore` false. The in-flight guard must not stay latched, or paging
    // is dead for the rest of the mount.
    const loadMore = vi.fn(() => {
      if (loadMore.mock.calls.length >= 2) near = false;
      return undefined;
    });
    renderList({ emails: makeEmails(2), hasMore: true, loadMore });

    await act(async () => {});
    expect(loadMore).toHaveBeenCalledTimes(2);
  });
});
