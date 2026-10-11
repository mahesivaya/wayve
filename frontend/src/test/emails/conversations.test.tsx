// Gmail-style conversations in the mail list: one row per conversation with a
// message count, unread while any message is, opening it reads the whole
// thread and shows the earlier messages, bulk actions cover every message, and
// a new reply moves the row to the top instead of listing it twice.
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
const getEmailThread = vi.fn();
const deleteEmail = vi.fn();
const markEmailRead = vi.fn();

vi.mock("../../api/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/email")>()),
  getAccounts: vi.fn().mockResolvedValue([]),
  getEmails: (params: unknown) => getEmails(params),
  getEmailThread: (id: number) => getEmailThread(id),
  getEmail: vi.fn(async (id: number) => ({ id, body: `body ${id}` })),
  getEmailBody: vi.fn(async (id: number) => ({ body: `body ${id}` })),
  getEmailAttachments: vi.fn().mockResolvedValue([]),
  deleteEmail: (id: number) => deleteEmail(id),
  markEmailRead: (id: number) => markEmailRead(id),
}));

import { EmailList } from "../../emails/EmailList";
import { ConversationView } from "../../emails/ConversationView";
import { useEmailInbox } from "../../emails/useEmailInbox";
import type { EmailItem } from "../../emails/types";

class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

// A conversation row: the newest message (your read reply) stands for three
// messages, one of which is still unread.
const row: EmailItem = {
  id: 12,
  thread_id: 5,
  account_id: 7,
  subject: "Re: Meeting: test",
  sender: "Me <me@x.com>",
  created_at: "2026-10-07T09:00:00Z",
  is_read: true,
  message_count: 3,
  unread_count: 1,
  message_ids: [12, 11, 10],
};

const thread: EmailItem[] = [
  {
    id: 10,
    sender: "Alice <alice@x.com>",
    created_at: "2026-07-19T10:00:00Z",
    is_read: true,
  },
  {
    id: 11,
    sender: "Alice <alice@x.com>",
    created_at: "2026-07-20T10:00:00Z",
    is_read: false,
  },
  {
    id: 12,
    sender: "Me <me@x.com>",
    created_at: "2026-10-07T09:00:00Z",
    is_read: true,
  },
];

describe("conversation rows in the list", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the message count and stays unread while any message is", () => {
    const { container } = render(
      <EmailList
        emails={[row]}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore={false}
        loadMore={() => {}}
        loadingMore={false}
        activeFolder="inbox"
      />
    );
    expect(screen.getAllByLabelText("3 messages").length).toBeGreaterThan(0);
    expect(container.querySelector(".email-item")?.className).toContain(
      "unread"
    );
  });

  it("shows no count for a single message", () => {
    render(
      <EmailList
        emails={[
          { ...row, message_count: 1, unread_count: 0, message_ids: [12] },
        ]}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore={false}
        loadMore={() => {}}
        loadingMore={false}
        activeFolder="inbox"
      />
    );
    expect(screen.queryByLabelText(/messages$/)).toBeNull();
  });
});

describe("earlier messages of an open conversation", () => {
  afterEach(cleanup);

  it("start collapsed and load their body on expand", async () => {
    const loadMessage = vi.fn(async (m: EmailItem) => ({
      ...m,
      body: "Hello from July",
    }));
    render(
      <ConversationView
        messages={thread.slice(0, 2)}
        loadMessage={loadMessage}
      />
    );

    const heads = screen.getAllByRole("button");
    expect(heads).toHaveLength(2);
    expect(heads[0].getAttribute("aria-expanded")).toBe("false");
    expect(loadMessage).not.toHaveBeenCalled();

    fireEvent.click(heads[0]);
    expect(await screen.findByText("Hello from July")).toBeTruthy();
    expect(loadMessage).toHaveBeenCalledWith(thread[0]);
  });
});

describe("useEmailInbox with conversations", () => {
  beforeEach(() => {
    getEmails.mockReset();
    getEmailThread.mockReset();
    deleteEmail.mockReset().mockResolvedValue(undefined);
    markEmailRead.mockReset().mockResolvedValue(undefined);
    getEmails.mockResolvedValue({ emails: [row], hasMore: false });
    getEmailThread.mockResolvedValue(thread);
  });
  afterEach(cleanup);

  const loaded = async () => {
    const hook = renderHook(() => useEmailInbox(1, ""));
    await waitFor(() => expect(hook.result.current.emails).toHaveLength(1));
    return hook;
  };

  it("asks the server for conversation rows", async () => {
    await loaded();
    expect(getEmails).toHaveBeenCalledWith(
      expect.objectContaining({ threads: true })
    );
  });

  it("opening a conversation loads it and marks its other unread messages read", async () => {
    const { result } = await loaded();
    await act(async () => {
      await result.current.openEmail(row);
    });
    await waitFor(() =>
      expect(result.current.conversation?.messages.map((m) => m.id)).toEqual([
        10, 11, 12,
      ])
    );
    expect(getEmailThread).toHaveBeenCalledWith(12);
    expect(markEmailRead).toHaveBeenCalledWith(11);
    expect(markEmailRead).not.toHaveBeenCalledWith(10);
    expect(result.current.emails[0].unread_count).toBe(0);
  });

  it("bulk delete on a conversation row deletes every message in it", async () => {
    const { result } = await loaded();
    await act(async () => {
      await result.current.bulkDelete([12]);
    });
    expect(deleteEmail.mock.calls.map((c) => c[0]).sort()).toEqual([
      10, 11, 12,
    ]);
    expect(result.current.emails).toHaveLength(0);
  });

  it("marking a conversation read posts only its unread messages", async () => {
    getEmails.mockResolvedValue({
      emails: [{ ...row, unread_ids: [11] }],
      hasMore: false,
    });
    const { result } = await loaded();
    await act(async () => {
      await result.current.bulkMarkRead([12]);
    });
    expect(markEmailRead.mock.calls.map((c) => c[0])).toEqual([11]);
  });

  it("an email grouped since it was listed is updated in place, not listed twice", async () => {
    const lone: EmailItem = {
      id: 5,
      account_id: 7,
      subject: "Hello",
      sender: "Ann <ann@x.com>",
      created_at: "2026-09-01T09:00:00Z",
      is_read: true,
    };
    const later: EmailItem = {
      ...lone,
      id: 30,
      created_at: "2026-10-01T09:00:00Z",
      subject: "Later",
    };
    getEmails.mockResolvedValueOnce({ emails: [later, lone], hasMore: false });
    const { result } = renderHook(() => useEmailInbox(1, ""));
    await waitFor(() => expect(result.current.emails).toHaveLength(2));

    // The backfill put email 5 into conversation 9 (key e5 → t9).
    const grouped = {
      ...lone,
      thread_id: 9,
      message_count: 1,
      message_ids: [5],
    };
    getEmails.mockResolvedValueOnce({
      emails: [later, grouped],
      hasMore: false,
    });
    act(() => {
      result.current.setRefreshTick((t) => t + 1);
    });

    await waitFor(() =>
      expect(
        result.current.emails.map((e) => [e.id, e.thread_id ?? null])
      ).toEqual([
        [30, null],
        [5, 9],
      ])
    );
  });

  it("two conversations that merged collapse into one row", async () => {
    const a = {
      ...row,
      id: 20,
      thread_id: 3,
      message_count: 1,
      message_ids: [20],
      created_at: "2026-09-01T09:00:00Z",
    };
    const b = {
      ...row,
      id: 21,
      thread_id: 4,
      message_count: 1,
      message_ids: [21],
      created_at: "2026-09-02T09:00:00Z",
    };
    getEmails.mockResolvedValueOnce({ emails: [b, a], hasMore: false });
    const { result } = renderHook(() => useEmailInbox(1, ""));
    await waitFor(() => expect(result.current.emails).toHaveLength(2));

    const merged = {
      ...b,
      thread_id: 3,
      message_count: 2,
      message_ids: [21, 20],
    };
    getEmails.mockResolvedValueOnce({ emails: [merged], hasMore: false });
    act(() => {
      result.current.setRefreshTick((t) => t + 1);
    });

    await waitFor(() =>
      expect(result.current.emails.map((e) => e.id)).toEqual([21])
    );
  });

  it("a slow answer for an earlier conversation never replaces the open one", async () => {
    const a = { ...row, id: 40, thread_id: 40, message_ids: [40, 41] };
    const b = { ...row, id: 50, thread_id: 50, message_ids: [50, 51] };
    getEmails.mockResolvedValue({ emails: [a, b], hasMore: false });
    const release: Record<number, (value: EmailItem[]) => void> = {};
    getEmailThread.mockImplementation(
      (id: number) =>
        new Promise<EmailItem[]>((resolve) => {
          release[id] = resolve;
        })
    );
    const { result } = renderHook(() => useEmailInbox(1, ""));
    await waitFor(() => expect(result.current.emails).toHaveLength(2));

    // Open A, then B before A's conversation has arrived.
    act(() => {
      void result.current.openEmail(a);
    });
    act(() => {
      void result.current.openEmail(b);
    });
    await waitFor(() => expect(release[50]).toBeDefined());

    // A's answer lands first, while B is the one open...
    await act(async () => {
      release[40]([{ ...a, id: 41 }, a]);
    });
    // ...then B's. B must be what the reading pane gets.
    await act(async () => {
      release[50]([{ ...b, id: 51 }, b]);
    });
    await waitFor(() => expect(result.current.conversation?.rowId).toBe(50));
    expect(result.current.conversation?.messages.map((m) => m.id)).toEqual([
      51, 50,
    ]);
  });

  it("a new reply moves the conversation to the top instead of listing it twice", async () => {
    const other: EmailItem = {
      id: 30,
      account_id: 7,
      subject: "Lunch",
      sender: "Bob <bob@x.com>",
      created_at: "2026-10-08T09:00:00Z",
      is_read: true,
    };
    getEmails.mockResolvedValueOnce({ emails: [other, row], hasMore: false });
    const { result } = renderHook(() => useEmailInbox(1, ""));
    await waitFor(() => expect(result.current.emails).toHaveLength(2));

    const newer = {
      ...row,
      id: 13,
      created_at: "2026-10-09T09:00:00Z",
      message_count: 4,
      message_ids: [13, 12, 11, 10],
    };
    getEmails.mockResolvedValueOnce({ emails: [newer, other], hasMore: false });
    act(() => {
      result.current.setRefreshTick((t) => t + 1);
    });

    await waitFor(() =>
      expect(result.current.emails.map((e) => e.id)).toEqual([13, 30])
    );
  });
});
