// The star on every email row, as in Gmail: an outline until starred, then
// filled, hovered or not. Clicking toggles it without opening the email; it
// flips at once and flips back if the server refuses. A conversation row is
// starred while any message is, and unstarring clears them all.
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
const starEmail = vi.fn();
const unstarEmail = vi.fn();

vi.mock("../../api/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/email")>()),
  getAccounts: vi.fn().mockResolvedValue([]),
  getEmails: (params: unknown) => getEmails(params),
  starEmail: (id: number) => starEmail(id),
  unstarEmail: (id: number) => unstarEmail(id),
}));

import { EmailList } from "../../emails/EmailList";
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

const plain: EmailItem = {
  id: 30,
  account_id: 7,
  subject: "Lunch",
  sender: "Bob <bob@x.com>",
  created_at: "2026-10-08T09:00:00Z",
  is_read: true,
};
// A conversation whose older message (11) is starred; its row is message 12.
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
  is_starred: true,
  starred_ids: [11],
};

describe("the star on each row", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const list = (
    onToggleStar?: (id: number) => Promise<unknown>,
    onOpenEmail = vi.fn()
  ) =>
    render(
      <EmailList
        emails={[plain, conversation]}
        selectedEmailId={null}
        onOpenEmail={onOpenEmail}
        hasMore={false}
        loadMore={() => {}}
        loadingMore={false}
        isListView
        activeFolder="inbox"
        onToggleStar={onToggleStar}
      />
    );

  it("is shown on every row, filled only when starred", () => {
    const { container } = list(vi.fn());
    const stars = container.querySelectorAll(".email-row-star");
    expect(stars).toHaveLength(2);
    expect(stars[0].className).not.toContain("is-starred");
    expect(stars[0].getAttribute("aria-pressed")).toBe("false");
    // Starred while any message is, though the row's own message isn't.
    expect(stars[1].className).toContain("is-starred");
    expect(stars[1].getAttribute("aria-pressed")).toBe("true");
  });

  it("toggles on click without opening the email", async () => {
    const onToggleStar = vi.fn().mockResolvedValue(undefined);
    const onOpenEmail = vi.fn();
    const { container } = list(onToggleStar, onOpenEmail);
    const star = container.querySelector(".email-row-star");
    fireEvent.click(star as Element);
    await waitFor(() => expect(onToggleStar).toHaveBeenCalledWith(30));
    expect(onOpenEmail).not.toHaveBeenCalled();
  });

  it("ignores a second click while the first is in flight", async () => {
    let finish = () => {};
    const onToggleStar = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const { container } = list(onToggleStar);
    const star = container.querySelector(".email-row-star") as Element;
    fireEvent.click(star);
    fireEvent.click(star);
    expect(onToggleStar).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("says why a star failed", async () => {
    const onToggleStar = vi
      .fn()
      .mockRejectedValue(new Error("Email provider rejected the star request"));
    const { container } = list(onToggleStar);
    fireEvent.click(container.querySelector(".email-row-star") as Element);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Email provider rejected the star request"
    );
  });

  it("keeps its column when the list has no star handler", () => {
    const { container } = list(undefined);
    expect(container.querySelectorAll(".email-row-star")).toHaveLength(0);
    expect(container.querySelectorAll(".email-row-star-slot")).toHaveLength(2);
  });
});

describe("useEmailInbox: toggleStar", () => {
  beforeEach(() => {
    getEmails.mockReset();
    starEmail.mockReset().mockResolvedValue(undefined);
    unstarEmail.mockReset().mockResolvedValue(undefined);
    getEmails.mockResolvedValue({
      emails: [plain, conversation],
      hasMore: false,
    });
  });
  afterEach(cleanup);

  const loaded = async () => {
    const hook = renderHook(() => useEmailInbox(1, ""));
    await waitFor(() => expect(hook.result.current.emails).toHaveLength(2));
    return hook;
  };

  it("stars the row's own message", async () => {
    const { result } = await loaded();
    await act(async () => {
      await result.current.toggleStar(30);
    });
    expect(starEmail).toHaveBeenCalledWith(30);
    expect(result.current.emails[0]).toMatchObject({
      is_starred: true,
      starred_ids: [30],
    });
  });

  it("unstarring a conversation clears every starred message in it", async () => {
    const { result } = await loaded();
    await act(async () => {
      await result.current.toggleStar(12);
    });
    expect(unstarEmail.mock.calls.map((c) => c[0])).toEqual([11]);
    expect(starEmail).not.toHaveBeenCalled();
    expect(result.current.emails[1]).toMatchObject({
      is_starred: false,
      starred_ids: [],
    });
  });

  it("flips the star back when the server refuses", async () => {
    starEmail.mockRejectedValue(new Error("nope"));
    const { result } = await loaded();
    await act(async () => {
      await expect(result.current.toggleStar(30)).rejects.toThrow("nope");
    });
    expect(result.current.emails[0].is_starred).toBeUndefined();
    expect(result.current.emails[0].starred_ids).toBeUndefined();
  });
});
