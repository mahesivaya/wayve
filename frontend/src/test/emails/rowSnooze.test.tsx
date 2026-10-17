// Snooze from the end of each row: a menu of times, drawn outside the row so
// the row can't clip it. Picking one hides the row's whole conversation from
// the inbox until then; Undo and the Snoozed folder's Unsnooze bring it back,
// and a refused snooze puts everything back and says why. The list pages on
// `sort_at`, so mail back from a snooze isn't skipped.
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getEmails = vi.fn();
const snoozeEmail = vi.fn();
const unsnoozeEmail = vi.fn();

vi.mock("../../api/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/email")>()),
  getAccounts: vi.fn().mockResolvedValue([]),
  getEmails: (params: unknown) => getEmails(params),
  snoozeEmail: (id: number, until: Date) => snoozeEmail(id, until),
  unsnoozeEmail: (id: number) => unsnoozeEmail(id),
}));

import { EmailList } from "../../emails/EmailList";
import { formatSnoozeTime } from "../../emails/snoozePresets";
import { useEmailInbox } from "../../emails/useEmailInbox";
import type { EmailFolder, EmailItem } from "../../emails/types";

class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const NOW = new Date("2026-10-16T17:00:00Z");

const conversation: EmailItem = {
  id: 12,
  thread_id: 5,
  account_id: 7,
  subject: "Plans",
  sender: "Alice <alice@x.com>",
  created_at: "2026-10-16T09:00:00Z",
  is_read: true,
  message_count: 2,
  message_ids: [12, 11],
};
const single: EmailItem = {
  id: 30,
  account_id: 7,
  subject: "Lunch",
  sender: "Bob <bob@x.com>",
  created_at: "2026-10-15T09:00:00Z",
  is_read: true,
};

describe("the row's Snooze action", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const list = (
    props: Partial<React.ComponentProps<typeof EmailList>> & {
      folder?: EmailFolder;
    }
  ) =>
    render(
      <EmailList
        emails={props.emails ?? [conversation, single]}
        selectedEmailId={null}
        onOpenEmail={props.onOpenEmail ?? (() => {})}
        hasMore={false}
        loadMore={() => {}}
        loadingMore={false}
        isListView
        activeFolder={props.folder ?? "inbox"}
        onMarkUnread={() => {}}
        onDelete={vi.fn()}
        onSnooze={props.onSnooze}
        onUnsnooze={props.onUnsnooze}
      />
    );

  it("sits at the end of the row's actions", () => {
    const { container } = list({ onSnooze: vi.fn() });
    const labels = Array.from(
      container.querySelector(".email-row-actions")?.querySelectorAll("button") ??
        []
    ).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Delete", "Mark as unread", "Snooze"]);
  });

  it("opens a menu outside the row with each time, and keeps the row's actions up", () => {
    const onOpenEmail = vi.fn();
    const { container } = list({ onSnooze: vi.fn(), onOpenEmail });
    fireEvent.click(screen.getAllByRole("button", { name: "Snooze" })[0]);

    const menu = screen.getByRole("menu", { name: "Snooze until" });
    // On <body>, not inside the row that would clip it.
    expect(container.contains(menu)).toBe(false);
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.firstChild?.textContent)
    ).toEqual(["2 minutes", "10 minutes", "30 minutes"]);
    expect(container.querySelector(".email-item")?.className).toContain(
      "menu-open"
    );
    expect(onOpenEmail).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("snoozes that row until the time picked, counted from the click", async () => {
    const onSnooze = vi.fn().mockResolvedValue(undefined);
    list({ onSnooze });
    fireEvent.click(screen.getAllByRole("button", { name: "Snooze" })[1]);
    // The menu stayed open a while before the pick.
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    fireEvent.click(screen.getByRole("menuitem", { name: /10 minutes/ }));

    await waitFor(() => expect(onSnooze).toHaveBeenCalledTimes(1));
    const [id, until] = onSnooze.mock.calls[0];
    expect(id).toBe(30);
    expect((until as Date).toISOString()).toBe("2026-10-16T17:11:00.000Z");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("says why a snooze failed", async () => {
    const onSnooze = vi
      .fn()
      .mockRejectedValue(new Error("Choose a time in the future"));
    list({ onSnooze });
    fireEvent.click(screen.getAllByRole("button", { name: "Snooze" })[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: /2 minutes/ }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Choose a time in the future"
    );
  });

  it("isn't offered where snoozing would hide nothing", () => {
    for (const folder of ["trash", "spam", "drafts"] as const) {
      list({ folder, onSnooze: vi.fn() });
      expect(screen.queryByRole("button", { name: "Snooze" })).toBeNull();
      cleanup();
    }
  });

  it("gives focus back to its button when the menu closes", () => {
    list({ onSnooze: vi.fn() });
    const button = screen.getAllByRole("button", { name: "Snooze" })[0];
    fireEvent.click(button);
    // The menu takes focus to its first time...
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    fireEvent.keyDown(document, { key: "Escape" });
    // ...and hands it back.
    expect(document.activeElement).toBe(button);
  });

  it("offers Unsnooze, and shows when it returns, in the Snoozed folder", async () => {
    const onUnsnooze = vi.fn().mockResolvedValue(undefined);
    const { container } = list({
      folder: "snoozed",
      emails: [{ ...single, snoozed_until: "2026-10-16T17:30:00Z" }],
      onSnooze: vi.fn(),
      onUnsnooze,
    });
    expect(screen.queryByRole("button", { name: "Snooze" })).toBeNull();
    expect(container.querySelector(".email-snooze-time")?.textContent).toBe(
      new Date("2026-10-16T17:30:00Z").toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Unsnooze" }));
    await waitFor(() => expect(onUnsnooze).toHaveBeenCalledWith(30));
  });
});

describe("useEmailInbox: snooze", () => {
  beforeEach(() => {
    getEmails.mockReset();
    snoozeEmail.mockReset().mockResolvedValue(undefined);
    unsnoozeEmail.mockReset().mockResolvedValue(undefined);
    getEmails.mockResolvedValue({
      emails: [conversation, single],
      hasMore: false,
    });
  });
  afterEach(cleanup);

  const loaded = async () => {
    const hook = renderHook(() => useEmailInbox(1, ""));
    await waitFor(() => expect(hook.result.current.emails).toHaveLength(2));
    return hook;
  };
  const until = new Date("2026-10-16T17:10:00Z");

  it("snoozes every message of a conversation and takes the row out of the inbox", async () => {
    const { result } = await loaded();
    let batch = { rows: [] as EmailItem[], ids: [] as number[] };
    await act(async () => {
      batch = await result.current.snoozeRow(12, until);
    });
    expect(snoozeEmail.mock.calls).toEqual([
      [12, until],
      [11, until],
    ]);
    expect(result.current.emails.map((e) => e.id)).toEqual([30]);
    expect(batch).toEqual({ rows: [conversation], ids: [12, 11] });
  });

  it("puts everything back when the server refuses", async () => {
    snoozeEmail.mockImplementation(async (id: number) => {
      if (id === 11) throw new Error("nope");
    });
    const { result } = await loaded();
    await act(async () => {
      await expect(result.current.snoozeRow(12, until)).rejects.toThrow("nope");
    });
    // The half that did snooze is unsnoozed again.
    expect(unsnoozeEmail.mock.calls.map((c) => c[0])).toEqual([12]);
    expect(result.current.emails.map((e) => e.id)).toEqual([12, 30]);
  });

  it("Undo ends the snooze and puts the row back in place", async () => {
    const { result } = await loaded();
    let batch = { rows: [] as EmailItem[], ids: [] as number[] };
    await act(async () => {
      batch = await result.current.snoozeRow(12, until);
    });
    let failed = -1;
    await act(async () => {
      failed = await result.current.undoSnooze(batch);
    });
    expect(failed).toBe(0);
    expect(unsnoozeEmail.mock.calls.map((c) => c[0]).sort()).toEqual([11, 12]);
    expect(result.current.emails.map((e) => e.id)).toEqual([12, 30]);
  });

  it("pages on sort_at, so mail back from a snooze isn't skipped", async () => {
    const returned = {
      ...single,
      id: 40,
      created_at: "2026-10-01T09:00:00Z",
      snoozed_until: "2026-10-16T16:58:00Z",
      sort_at: "2026-10-16T16:58:00Z",
    };
    getEmails.mockResolvedValueOnce({ emails: [returned], hasMore: true });
    const { result } = renderHook(() => useEmailInbox(1, ""));
    await waitFor(() => expect(result.current.emails).toHaveLength(1));
    getEmails.mockResolvedValueOnce({ emails: [], hasMore: false });
    await act(async () => {
      await result.current.loadMore();
    });
    expect(getEmails).toHaveBeenLastCalledWith(
      expect.objectContaining({
        before: new Date("2026-10-16T16:58:00Z").getTime(),
        beforeId: 40,
      })
    );
  });
});

describe("formatSnoozeTime", () => {
  // Local times, so the day boundaries are the viewer's.
  const now = new Date(2026, 9, 16, 17, 0); // Fri 16 Oct, 5:00 PM
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0);
  const time = (d: Date) =>
    d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  it("shows only the time today", () => {
    expect(formatSnoozeTime(at(16, 19), now)).toBe(time(at(16, 19)));
  });

  it("says Tomorrow for tomorrow", () => {
    expect(formatSnoozeTime(at(17, 8), now)).toBe(`Tomorrow ${time(at(17, 8))}`);
  });

  it("names the weekday within the week, and the date after that", () => {
    const sun = at(18, 8);
    expect(formatSnoozeTime(sun, now)).toBe(
      `${sun.toLocaleDateString([], { weekday: "short" })} ${time(sun)}`
    );
    const later = at(30, 8);
    expect(formatSnoozeTime(later, now)).toBe(
      `${later.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time(later)}`
    );
  });
});
