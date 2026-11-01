import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMAIL_PAGE_SIZE, EmailList } from "../../emails/EmailList";
import type { EmailItem } from "../../emails/types";

// The inbox shows EMAIL_PAGE_SIZE rows per page with ‹ / › buttons, and
// keeps one row past the current page loaded via `loadMore`. Counts below are
// written in terms of the page size so they hold whatever it is set to.
const P = EMAIL_PAGE_SIZE;
// The pager's label: the page number, or "page/pages" when a total is known.
// "1–50" before the arrows: the emails this page shows (no total).
const emailsLabel = (text: string) =>
  screen.getByText(text, { selector: ".email-pager-emails" });
const label = (text: string) =>
  screen.getByText(text, { selector: ".email-pager-range" });
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

    expect(label("1")).toBeTruthy();
    expect(screen.getAllByText(subject(P)).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(subject(P + 1))).toHaveLength(0);
    expect((newer() as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(older());
    expect(label("2")).toBeTruthy();
    expect(screen.getAllByText(subject(P + 1)).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(subject(P))).toHaveLength(0);

    await userEvent.click(older());
    expect(label("3")).toBeTruthy();
    expect((older() as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(newer());
    expect(label("2")).toBeTruthy();
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
    expect(label("2")).toBeTruthy();
  });

  it("falls back to the last page when rows leave it", async () => {
    const { rerenderWith } = renderList({
      emails: makeEmails(2 * P + 5),
      hasMore: false,
      scrollKey: "shrink",
    });
    await userEvent.click(older());
    await userEvent.click(older());
    expect(label("3")).toBeTruthy();

    rerenderWith({
      emails: makeEmails(2 * P - 2),
      hasMore: false,
      scrollKey: "shrink",
    });
    expect(label("2")).toBeTruthy();
  });
});

describe("EmailList page count", () => {
  afterEach(() => {
    cleanup();
  });

  const withTotal = (emails: EmailItem[], total: number | null) =>
    render(
      <EmailList
        emails={emails}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore={false}
        loadMore={vi.fn()}
        loadingMore={false}
        activeFolder="inbox"
        scrollKey={`total-${total}`}
        total={total}
      />
    );

  it("shows page/pages between the arrows when the total is known", async () => {
    withTotal(makeEmails(P + 1), 2 * P + 5);
    expect(label("1/3")).toBeTruthy();
    expect(emailsLabel(`1–${P}`)).toBeTruthy();
    await userEvent.click(older());
    expect(label("2/3")).toBeTruthy();
    expect(emailsLabel(`${P + 1}–${P + 1}`)).toBeTruthy();
  });

  it("never shows fewer pages than are already loaded", () => {
    // Rows synced in after the server counted.
    withTotal(makeEmails(P + 1), P);
    expect(label("1/2")).toBeTruthy();
  });

  it("shows just the page number without a total", () => {
    withTotal(makeEmails(5), null);
    expect(label("1")).toBeTruthy();
    expect(emailsLabel("1–5")).toBeTruthy();
  });
});

describe("EmailList pager placement", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the pager into the toolbar slot when one is given", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    const { container } = render(
      <EmailList
        emails={makeEmails(P + 1)}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore={false}
        loadMore={vi.fn()}
        loadingMore={false}
        activeFolder="inbox"
        scrollKey="slot"
        pagerSlot={slot}
      />
    );
    expect(slot.querySelector(".email-pager")).not.toBeNull();
    expect(container.querySelector(".email-pager")).toBeNull();
    slot.remove();
  });
});

describe("EmailList page menu", () => {
  afterEach(() => {
    cleanup();
  });

  const openMenu = () =>
    userEvent.click(screen.getByRole("button", { name: /choose a page/ }));

  it("lists every page and jumps to the one picked", async () => {
    render(
      <EmailList
        emails={makeEmails(2 * P + 5)}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore={false}
        loadMore={vi.fn()}
        loadingMore={false}
        activeFolder="inbox"
        scrollKey="menu-pick"
        total={2 * P + 5}
      />
    );
    await openMenu();
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["1✓", "2", "3"]);

    await userEvent.click(options[2]);
    expect(label("3/3")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape", async () => {
    render(
      <EmailList
        emails={makeEmails(P + 1)}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore={false}
        loadMore={vi.fn()}
        loadingMore={false}
        activeFolder="inbox"
        scrollKey="menu-escape"
        total={P + 1}
      />
    );
    await openMenu();
    expect(screen.getByRole("listbox")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("stays on the current page while a far page loads, then shows it", async () => {
    const loadMore = vi.fn();
    const props = {
      selectedEmailId: null,
      onOpenEmail: () => {},
      loadMore,
      loadingMore: false,
      activeFolder: "inbox" as const,
      scrollKey: "menu-far",
      total: 4 * P,
    };
    const { rerender } = render(
      <EmailList {...props} emails={makeEmails(P + 1)} hasMore />
    );
    await openMenu();
    await userEvent.click(screen.getAllByRole("option")[3]);

    // Page 4 isn't loaded yet: rows of page 1 stay, the label says where
    // it's going, and loading walks forward.
    expect(screen.getAllByText(subject(1)).length).toBeGreaterThan(0);
    expect(label("4/4")).toBeTruthy();
    await act(async () => {});
    expect(loadMore).toHaveBeenCalled();

    rerender(
      <EmailList {...props} emails={makeEmails(4 * P)} hasMore={false} />
    );
    expect(screen.getAllByText(subject(3 * P + 1)).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(subject(1))).toHaveLength(0);
    expect(label("4/4")).toBeTruthy();
  });
});

describe("EmailList page menu scroll hint", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows ▾ while pages lie below the menu's edge, and drops it at the end", async () => {
    // jsdom does no layout: fake a menu taller than its viewport.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
    const { container } = render(
      <EmailList
        emails={makeEmails(P + 1)}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore={false}
        loadMore={vi.fn()}
        loadingMore={false}
        activeFolder="inbox"
        scrollKey="menu-hint"
        total={27 * P}
      />
    );
    await userEvent.click(
      screen.getByRole("button", { name: /choose a page/ })
    );
    expect(container.querySelector(".email-pager-menu-more")).not.toBeNull();

    const menu = screen.getByRole("listbox");
    menu.scrollTop = 300;
    await act(async () => {
      menu.dispatchEvent(new Event("scroll"));
    });
    expect(container.querySelector(".email-pager-menu-more")).toBeNull();
  });
});

describe("EmailList select-all placement", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts select-all in the toolbar slot and shows the bulk bar only for a selection", async () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    const { container } = render(
      <EmailList
        emails={makeEmails(3)}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore={false}
        loadMore={vi.fn()}
        loadingMore={false}
        activeFolder="inbox"
        isListView
        scrollKey="select-slot"
        selectSlot={slot}
        onBulkDelete={vi.fn()}
      />
    );
    expect(slot.querySelector(".email-bulk-master")).not.toBeNull();
    expect(container.querySelector(".email-bulk-bar")).toBeNull();

    await userEvent.click(
      screen.getByRole("checkbox", { name: "Select all emails" })
    );
    expect(container.querySelector(".email-bulk-bar")).not.toBeNull();
    expect(screen.getByText("3 selected")).toBeTruthy();
    slot.remove();
  });

  it("offers select-all and row checkboxes in split view too", async () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    render(
      <EmailList
        emails={makeEmails(3)}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore={false}
        loadMore={vi.fn()}
        loadingMore={false}
        activeFolder="inbox"
        isListView={false}
        scrollKey="select-split"
        selectSlot={slot}
        onBulkDelete={vi.fn()}
      />
    );
    expect(slot.querySelector(".email-bulk-master")).not.toBeNull();
    const rowBoxes = screen.getAllByRole("checkbox", { name: /Select email/ });
    expect(rowBoxes).toHaveLength(3);
    await userEvent.click(rowBoxes[0]);
    expect(screen.getByText("1 selected")).toBeTruthy();
    slot.remove();
  });
});
