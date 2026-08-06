import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmailList } from "../../emails/EmailList";
import type { EmailItem } from "../../emails/types";

// jsdom ships no IntersectionObserver. The stub mirrors the one behaviour the
// paging logic depends on: observing a target always delivers an initial
// callback describing its current intersection, even if nothing moved. That is
// exactly what makes re-observing after each page the fix for a stalled list.
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
    vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps paging while the sentinel stays in view", async () => {
    // The regression this guards: IntersectionObserver reports *changes*, so an
    // observer bound once never fires again when a page lands and the sentinel
    // is still within the root margin — the list stalls with rows outstanding.
    const loadMore = vi.fn(async () => {});
    const { rerender } = renderList({
      emails: makeEmails(2),
      hasMore: true,
      loadMore,
    });

    await act(async () => {});
    expect(loadMore).toHaveBeenCalledTimes(1);

    // A page arrives and the sentinel is still visible: paging must continue.
    rerender(
      <EmailList
        emails={makeEmails(4)}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore
        loadMore={loadMore}
        loadingMore={false}
        activeFolder="inbox"
      />
    );

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
    const loadMore = vi.fn(() => undefined);
    const { rerender } = renderList({
      emails: makeEmails(2),
      hasMore: true,
      loadMore,
    });

    await act(async () => {});
    expect(loadMore).toHaveBeenCalledTimes(1);

    rerender(
      <EmailList
        emails={makeEmails(3)}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore
        loadMore={loadMore}
        loadingMore={false}
        activeFolder="inbox"
      />
    );

    await act(async () => {});
    expect(loadMore).toHaveBeenCalledTimes(2);
  });
});
