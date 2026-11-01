import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMAIL_PAGE_SIZE, EmailList } from "../../emails/EmailList";
import type { EmailItem } from "../../emails/types";

// The inbox shows EMAIL_PAGE_SIZE rows per page with ‹ / › buttons, and
// keeps one row past the current page loaded via `loadMore`. Counts below are
// written in terms of the page size so they hold whatever it is set to.
const P = EMAIL_PAGE_SIZE;
const range = (from: number, to: number) => `${from}–${to}`;
const subject = (n: number) => `Subject ${n}`;

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
  loadMore?: () => void | Promise<void>;
  loadingMore?: boolean;
  scrollKey?: string;
}) {
  const element = (p: typeof props) => (
    <EmailList
      emails={p.emails}
      selectedEmailId={null}
      onOpenEmail={() => {}}
      hasMore={p.hasMore}
      loadMore={p.loadMore ?? vi.fn()}
      loadingMore={p.loadingMore ?? false}
      activeFolder="inbox"
      scrollKey={p.scrollKey ?? "paging-test"}
    />
  );
  const utils = render(element(props));
  return {
    ...utils,
    rerenderWith: (next: typeof props) => utils.rerender(element(next)),
  };
}

const older = () => screen.getByRole("button", { name: "Older" });
const newer = () => screen.getByRole("button", { name: "Newer" });

describe("EmailList pages", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows a page of rows at a time and steps through them", async () => {
    renderList({
      emails: makeEmails(2 * P + 5),
      hasMore: false,
      scrollKey: "steps",
    });

    expect(screen.getByText(range(1, P))).toBeTruthy();
    expect(screen.getAllByText(subject(P)).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(subject(P + 1))).toHaveLength(0);
    expect((newer() as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(older());
    expect(screen.getByText(range(P + 1, 2 * P))).toBeTruthy();
    expect(screen.getAllByText(subject(P + 1)).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(subject(P))).toHaveLength(0);

    await userEvent.click(older());
    expect(screen.getByText(range(2 * P + 1, 2 * P + 5))).toBeTruthy();
    expect((older() as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(newer());
    expect(screen.getByText(range(P + 1, 2 * P))).toBeTruthy();
  });

  it("loads ahead until it knows whether a next page exists", async () => {
    const loadMore = vi.fn();
    renderList({ emails: makeEmails(P), hasMore: true, loadMore });
    await act(async () => {});
    expect(loadMore).toHaveBeenCalledTimes(1);
    // Nothing loaded past this page yet, so Older can't be offered.
    expect((older() as HTMLButtonElement).disabled).toBe(true);
  });

  it("doesn't load when the next page is already there", async () => {
    const loadMore = vi.fn();
    renderList({ emails: makeEmails(P + 1), hasMore: true, loadMore });
    await act(async () => {});
    expect(loadMore).not.toHaveBeenCalled();
    expect((older() as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks once per cursor, so an empty de-duped batch can't loop", async () => {
    const loadMore = vi.fn();
    const emails = makeEmails(P);
    const { rerenderWith } = renderList({ emails, hasMore: true, loadMore });
    await act(async () => {});
    rerenderWith({ emails, hasMore: true, loadMore, loadingMore: true });
    rerenderWith({ emails, hasMore: true, loadMore, loadingMore: false });
    await act(async () => {});
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("stops asking once the server says there is nothing left", async () => {
    const loadMore = vi.fn();
    renderList({ emails: makeEmails(5), hasMore: false, loadMore });
    await act(async () => {});
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("returns to the same page after the list remounts", async () => {
    const first = renderList({
      emails: makeEmails(2 * P + 5),
      hasMore: false,
      scrollKey: "remount",
    });
    await userEvent.click(older());
    first.unmount();

    renderList({
      emails: makeEmails(2 * P + 5),
      hasMore: false,
      scrollKey: "remount",
    });
    expect(screen.getByText(range(P + 1, 2 * P))).toBeTruthy();
  });

  it("falls back to the last page when rows leave it", async () => {
    const { rerenderWith } = renderList({
      emails: makeEmails(2 * P + 5),
      hasMore: false,
      scrollKey: "shrink",
    });
    await userEvent.click(older());
    await userEvent.click(older());
    expect(screen.getByText(range(2 * P + 1, 2 * P + 5))).toBeTruthy();

    rerenderWith({
      emails: makeEmails(2 * P - 2),
      hasMore: false,
      scrollKey: "shrink",
    });
    expect(screen.getByText(range(P + 1, 2 * P - 2))).toBeTruthy();
  });
});
