// Delete on each email row (shown on hover): one click moves the row's whole
// conversation to Trash with no confirm, Undo brings it back, a failure keeps
// the row and says why, and rows in the Trash folder offer Restore instead.
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getEmails = vi.fn();
const trashEmails = vi.fn();
const restoreEmails = vi.fn();

vi.mock("../../api/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/email")>()),
  getAccounts: vi.fn().mockResolvedValue([]),
  getEmails: (params: unknown) => getEmails(params),
  trashEmails: (ids: number[]) => trashEmails(ids),
  restoreEmails: (ids: number[]) => restoreEmails(ids),
}));

import { EmailList } from "../../emails/EmailList";
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

// A three-message conversation, and a single email below it.
const conversation: EmailItem = {
  id: 12,
  thread_id: 5,
  account_id: 7,
  subject: "Plans",
  sender: "Alice <alice@x.com>",
  created_at: "2026-10-07T09:00:00Z",
  is_read: true,
  message_count: 3,
  message_ids: [12, 11, 10],
};
const single: EmailItem = {
  id: 30,
  account_id: 7,
  subject: "Lunch",
  sender: "Bob <bob@x.com>",
  created_at: "2026-10-01T09:00:00Z",
  is_read: true,
};

describe("the row's Delete and Restore actions", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const list = (
    props: Partial<React.ComponentProps<typeof EmailList>> & {
      folder?: EmailFolder;
    }
  ) =>
    render(
      <EmailList
        emails={[conversation, single]}
        selectedEmailId={null}
        onOpenEmail={props.onOpenEmail ?? (() => {})}
        hasMore={false}
        loadMore={() => {}}
        loadingMore={false}
        isListView
        activeFolder={props.folder ?? "inbox"}
        onMarkRead={() => {}}
        onMarkUnread={() => {}}
        onBulkDelete={props.onBulkDelete}
        onBulkRestore={props.onBulkRestore}
        onDelete={props.onDelete}
        onRestore={props.onRestore}
      />
    );

  it("deletes that row with one click, no confirm, and doesn't open it", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const onOpenEmail = vi.fn();
    list({ onDelete, onOpenEmail });

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(30));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onOpenEmail).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("comes before the read toggle in the row's actions", () => {
    const { container } = list({ onDelete: vi.fn() });
    const actions = container.querySelector(".email-row-actions");
    const labels = Array.from(actions?.querySelectorAll("button") ?? []).map(
      (b) => b.getAttribute("aria-label")
    );
    expect(labels).toEqual(["Delete", "Mark as unread"]);
  });

  it("ignores a second click while the first is in flight", async () => {
    let finish = () => {};
    const onDelete = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    list({ onDelete });
    const button = screen.getAllByRole("button", { name: "Delete" })[0];
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onDelete).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("shows why a delete failed", async () => {
    const onDelete = vi
      .fn()
      .mockRejectedValue(
        new Error("Reconnect your email account to delete this email")
      );
    list({ onDelete });
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Reconnect your email account to delete this email"
    );
  });

  it("drops a deleted row from the selection", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    list({ onDelete, onBulkDelete: vi.fn() });
    fireEvent.click(screen.getByLabelText('Select email "Lunch"'));
    expect(screen.getByText("1 selected")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    await waitFor(() => expect(screen.queryByText("1 selected")).toBeNull());
  });

  it("offers Restore instead of Delete in the Trash folder", async () => {
    const onDelete = vi.fn();
    const onRestore = vi.fn().mockResolvedValue(undefined);
    list({ folder: "trash", onDelete, onRestore });
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Restore to inbox" })[0]
    );
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(12));
  });

  it("restores a Trash selection from the bulk bar, without a confirm", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const onBulkRestore = vi.fn().mockResolvedValue(undefined);
    list({ folder: "trash", onBulkRestore });
    fireEvent.click(screen.getByLabelText('Select email "Plans"'));
    fireEvent.click(screen.getByLabelText('Select email "Lunch"'));
    fireEvent.click(
      screen.getByRole("button", { name: "Restore selected to inbox" })
    );
    await waitFor(() => expect(onBulkRestore).toHaveBeenCalledWith([12, 30]));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
    // The selection clears once it's done.
    await waitFor(() => expect(screen.queryByText("2 selected")).toBeNull());
  });

  it("has no bulk Restore outside Trash", () => {
    list({ onBulkDelete: vi.fn() });
    fireEvent.click(screen.getByLabelText('Select email "Lunch"'));
    expect(
      screen.queryByRole("button", { name: "Restore selected to inbox" })
    ).toBeNull();
  });

  it("isn't shown when the list has no delete handler", () => {
    list({});
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("useEmailInbox: delete to Trash and Undo", () => {
  beforeEach(() => {
    getEmails.mockReset();
    trashEmails.mockReset().mockImplementation(async (ids: number[]) => ({ done: ids, failed: [] }));
    restoreEmails.mockReset().mockImplementation(async (ids: number[]) => ({ done: ids, failed: [] }));
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

  it("deletes every message of a conversation row and hands back what it took", async () => {
    const { result } = await loaded();
    let batch: Awaited<ReturnType<typeof result.current.deleteEmail>> | null =
      null;
    await act(async () => {
      batch = await result.current.deleteEmail(12);
    });
    // One request for the whole conversation, not one per message.
    expect(trashEmails).toHaveBeenCalledTimes(1);
    expect(trashEmails).toHaveBeenCalledWith([12, 11, 10]);
    expect(result.current.emails.map((e) => e.id)).toEqual([30]);
    expect(batch).toEqual({ rows: [conversation], ids: [12, 11, 10] });
  });

  it("keeps the row when the delete fails", async () => {
    trashEmails.mockResolvedValue({
      done: [],
      failed: [{ id: 30, error: "Email provider rejected" }],
    });
    const { result } = await loaded();
    await act(async () => {
      await expect(result.current.deleteEmail(30)).rejects.toThrow(
        "Email provider rejected"
      );
    });
    expect(result.current.emails.map((e) => e.id)).toEqual([12, 30]);
  });

  it("Undo restores every message and puts the row back in place", async () => {
    const { result } = await loaded();
    let batch = { rows: [] as EmailItem[], ids: [] as number[] };
    await act(async () => {
      batch = await result.current.deleteEmail(12);
    });
    let failed = -1;
    await act(async () => {
      failed = await result.current.undoTrash(batch);
    });
    expect(failed).toBe(0);
    expect(restoreEmails).toHaveBeenCalledTimes(1);
    expect(restoreEmails).toHaveBeenCalledWith([12, 11, 10]);
    // Newest first, as the list is sorted.
    expect(result.current.emails.map((e) => e.id)).toEqual([12, 30]);
  });

  it("Undo leaves out a row whose restore failed, and counts it", async () => {
    restoreEmails.mockResolvedValue({
      done: [12, 10],
      failed: [{ id: 11, error: "nope" }],
    });
    const { result } = await loaded();
    let batch = { rows: [] as EmailItem[], ids: [] as number[] };
    await act(async () => {
      batch = await result.current.deleteEmail(12);
    });
    let failed = -1;
    await act(async () => {
      failed = await result.current.undoTrash(batch);
    });
    expect(failed).toBe(1);
    expect(result.current.emails.map((e) => e.id)).toEqual([30]);
  });

  it("restoring from Trash takes the row out of the Trash list", async () => {
    const { result } = await loaded();
    await act(async () => {
      await result.current.restoreEmail(30);
    });
    expect(restoreEmails).toHaveBeenCalledWith([30]);
    expect(result.current.emails.map((e) => e.id)).toEqual([12]);
  });

  it("restores a Trash selection in one request", async () => {
    const { result } = await loaded();
    let outcome = { restored: -1, failed: -1 } as {
      restored: number;
      failed: number;
      error?: string;
    };
    await act(async () => {
      outcome = await result.current.bulkRestore([12, 30]);
    });
    expect(restoreEmails).toHaveBeenCalledTimes(1);
    expect(restoreEmails).toHaveBeenCalledWith([12, 30]);
    expect(outcome).toEqual({ restored: 2, failed: 0, error: undefined });
    expect(result.current.emails).toHaveLength(0);
  });

  it("puts back the Trash rows that couldn't be restored, and says why", async () => {
    restoreEmails.mockResolvedValue({
      done: [12],
      failed: [{ id: 30, error: "Reconnect your email account" }],
    });
    const { result } = await loaded();
    let outcome = { restored: -1, failed: -1 } as {
      restored: number;
      failed: number;
      error?: string;
    };
    await act(async () => {
      outcome = await result.current.bulkRestore([12, 30]);
    });
    expect(outcome).toEqual({
      restored: 1,
      failed: 1,
      error: "Reconnect your email account",
    });
    expect(result.current.emails.map((e) => e.id)).toEqual([30]);
  });

  it("puts every row back when the restore request fails outright", async () => {
    restoreEmails.mockRejectedValue(new Error("Network down"));
    const { result } = await loaded();
    let outcome = { restored: -1, failed: -1 } as {
      restored: number;
      failed: number;
      error?: string;
    };
    await act(async () => {
      outcome = await result.current.bulkRestore([12, 30]);
    });
    expect(outcome).toEqual({ restored: 0, failed: 2, error: "Network down" });
    expect(result.current.emails.map((e) => e.id)).toEqual([12, 30]);
  });
});
