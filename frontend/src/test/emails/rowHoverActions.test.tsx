// Per-row hover actions: Delete and Snooze sit ahead of the read/unread
// toggle, and snoozing picks a real future time. The ordering is the point of
// the test — it is easy to reintroduce a button in the wrong slot, and nothing
// else asserts it.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { EmailList } from "../../emails/EmailList";
import type { EmailItem } from "../../emails/types";

// jsdom ships no IntersectionObserver and the list's paging sentinel builds one
// on mount. These tests never page, so a no-op stub is enough.
beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
});

const email: EmailItem = {
  id: 7,
  account_id: 1,
  subject: "Quarterly report",
  sender: "Ada <ada@test.local>",
  receiver: "me@test.local",
  body: "Numbers attached.",
  created_at: "2026-10-16T09:00:00Z",
  is_read: true,
};

function renderList(props: Record<string, unknown> = {}) {
  const onSnooze = vi.fn();
  const onBulkDelete = vi.fn();
  render(
    <EmailList
      emails={[email]}
      selectedEmailId={null}
      onOpenEmail={vi.fn()}
      hasMore={false}
      loadMore={vi.fn()}
      loadingMore={false}
      scrollKey="test"
      onBulkDelete={onBulkDelete}
      onMarkUnread={vi.fn()}
      onSnooze={onSnooze}
      isListView
      showChrome
      hasAccounts
      accountsLoaded
      {...props}
    />
  );
  return { onSnooze, onBulkDelete };
}

describe("email row hover actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("orders Delete and Snooze before the read/unread toggle", () => {
    renderList();
    const row = screen.getByRole("button", { name: "Delete" }).parentElement!;
    const labels = within(row)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    // Attachment button is absent on this fixture, so this is the full set.
    expect(labels).toEqual(["Delete", "Snooze", "Mark as unread"]);
  });

  it("deletes just that row through the bulk handler", () => {
    const { onBulkDelete } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onBulkDelete).toHaveBeenCalledWith([7]);
  });

  it("offers the presets and snoozes to a future time", () => {
    const { onSnooze } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));

    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual([
      "Later today",
      "Tomorrow",
      "Next week",
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Tomorrow" }));
    expect(onSnooze).toHaveBeenCalledTimes(1);
    const [id, until] = onSnooze.mock.calls[0];
    expect(id).toBe(7);
    // A snooze in the past is rejected by the backend, so the preset must
    // always resolve ahead of now.
    expect((until as Date).getTime()).toBeGreaterThan(Date.now());
  });

  // Regression: the menu used to render inside the row, where
  // `.email-item { overflow: hidden }` clipped it — it appeared to vanish
  // under the next row. It must be portalled out of the list entirely.
  it("renders the menu outside the email row so it cannot be clipped", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));

    const menu = screen.getByRole("menu");
    expect(menu.closest(".email-item")).toBeNull();
    expect(menu.closest(".email-list")).toBeNull();
    expect(menu.parentElement).toBe(document.body);
    // Anchored by inline viewport coordinates (jsdom loads no stylesheet, so
    // the `position: fixed` itself lives in emails.css and isn't assertable).
    expect(menu.style.top).not.toBe("");
    expect(menu.style.right).not.toBe("");
  });

  it("offers Unsnooze instead of the menu inside the Snoozed folder", () => {
    const { onSnooze } = renderList({ activeFolder: "snoozed" });
    expect(screen.queryByRole("button", { name: "Snooze" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Unsnooze" }));
    // null is what clears `snoozed_until` server-side.
    expect(onSnooze).toHaveBeenCalledWith(7, null);
  });

  it("hides the snooze control when the host passes no handler", () => {
    renderList({ onSnooze: undefined });
    expect(screen.queryByRole("button", { name: "Snooze" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});
