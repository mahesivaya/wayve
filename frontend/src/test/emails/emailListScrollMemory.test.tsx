import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmailList } from "../../emails/EmailList";
import { __resetListScrollMemory } from "../../emails/useListScrollMemory";
import type { EmailItem } from "../../emails/types";

// Same stub as the paging test: jsdom has no IntersectionObserver, and the list
// binds one for infinite scroll. Nothing here exercises paging, so it reports
// "not intersecting" and never asks for another page.
class StubIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: ReadonlyArray<number> = [];
  constructor(_callback: IntersectionObserverCallback) {}
  observe() {}
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

function renderList(scrollKey: string) {
  return render(
    <EmailList
      emails={makeEmails(40)}
      selectedEmailId={null}
      onOpenEmail={() => {}}
      hasMore={false}
      loadMore={() => {}}
      loadingMore={false}
      activeFolder="inbox"
      scrollKey={scrollKey}
    />
  );
}

// jsdom lays nothing out, so a real `scrollTop` assignment is clamped to 0 and
// couldn't tell a working restore from a broken one. The accessor has to be on
// the prototype rather than the element: the hook writes during the mount's
// layout effect, before a test could reach the node to patch it.
const scrollTops = new WeakMap<HTMLElement, number>();
let nativeScrollTop: PropertyDescriptor | undefined;

function stubScrollTop() {
  nativeScrollTop = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTop"
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      scrollTops.set(this, value);
    },
  });
}

function restoreScrollTop() {
  if (nativeScrollTop) {
    Object.defineProperty(HTMLElement.prototype, "scrollTop", nativeScrollTop);
  }
}

function listPane(container: HTMLElement): HTMLElement {
  const pane = container.querySelector(".email-list");
  if (!(pane instanceof HTMLElement)) {
    throw new Error("email list pane not found");
  }
  return pane;
}

describe("EmailList scroll memory", () => {
  beforeEach(() => {
    __resetListScrollMemory();
    stubScrollTop();
    vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    restoreScrollTop();
    vi.unstubAllGlobals();
  });

  it("restores the scroll offset when the list remounts", () => {
    // Scroll down, then unmount — what opening an email does in list view.
    const first = renderList("1:inbox");
    const pane = listPane(first.container);
    pane.scrollTop = 1200;
    pane.dispatchEvent(new Event("scroll"));
    first.unmount();

    // Back mounts a fresh list with the same rows; it should not start at 0.
    const second = renderList("1:inbox");
    expect(listPane(second.container).scrollTop).toBe(1200);
  });

  it("keeps the offset without a scroll event, from unmount alone", () => {
    const first = renderList("1:inbox");
    listPane(first.container).scrollTop = 640;
    first.unmount();

    const second = renderList("1:inbox");
    expect(listPane(second.container).scrollTop).toBe(640);
  });

  it("starts a different folder at the top", () => {
    const first = renderList("1:inbox");
    const pane = listPane(first.container);
    pane.scrollTop = 900;
    pane.dispatchEvent(new Event("scroll"));
    first.unmount();

    const other = renderList("1:sent");
    expect(listPane(other.container).scrollTop).toBe(0);
  });

  it("still has the first folder's offset after visiting another", () => {
    const inbox = renderList("1:inbox");
    const inboxPane = listPane(inbox.container);
    inboxPane.scrollTop = 300;
    inboxPane.dispatchEvent(new Event("scroll"));
    inbox.unmount();

    const sent = renderList("1:sent");
    sent.unmount();

    const back = renderList("1:inbox");
    expect(listPane(back.container).scrollTop).toBe(300);
  });
});
