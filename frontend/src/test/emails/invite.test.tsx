// Meeting invitations: the 📅 mark on invitation rows, and the card above an
// invitation's body: what, when (in the viewer's zone), where, Join, and who
// organized it, or nothing when the email carries no readable invitation.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getEmailInvite = vi.fn();
// Set to make the next load fail. Kept apart from the vi.fn: a rejection
// returned by a mock that was reset or cleared beforehand is reported by
// Vitest as a test error, though the card handles it.
let failWith: Error | null = null;

vi.mock("../../api/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/email")>()),
  getEmailInvite: (id: number) =>
    failWith ? Promise.reject(failWith) : getEmailInvite(id),
}));

import type { EmailInvite } from "../../api/email";
import { EmailList } from "../../emails/EmailList";
import { InviteCard } from "../../emails/InviteCard";
import { inviteLabel, inviteWhen } from "../../emails/inviteFormat";
import type { EmailItem } from "../../emails/types";

const base: EmailInvite = {
  method: "request",
  title: "Design review",
  start: null,
  end: null,
  all_day: false,
  start_date: null,
  end_date: null,
  start_local: null,
  end_local: null,
  time_zone: null,
  location: null,
  join_url: null,
  organizer_name: null,
  organizer_email: null,
  status: null,
};

const time = (d: Date) =>
  d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

describe("inviteWhen / inviteLabel", () => {
  it("shows a same-day meeting as one date with a time range, in local time", () => {
    const start = "2026-10-20T19:00:00Z";
    const end = "2026-10-20T19:30:00Z";
    const text = inviteWhen({ ...base, start, end }) ?? "";
    expect(text).toContain(time(new Date(start)));
    expect(text).toContain(`– ${time(new Date(end))}`);
  });

  it("shows an all-day event by date, its end date being exclusive", () => {
    const one = inviteWhen({
      ...base,
      all_day: true,
      start_date: "2026-10-24",
      end_date: "2026-10-25",
    });
    expect(one).toMatch(/Oct 24.*· All day$/);
    expect(one).not.toContain("Oct 25");
    const two = inviteWhen({
      ...base,
      all_day: true,
      start_date: "2026-10-24",
      end_date: "2026-10-26",
    });
    expect(two).toMatch(/Oct 24.*–.*Oct 25.*All day/);
  });

  it("keeps a time in an unknown zone as written, naming the zone", () => {
    const text = inviteWhen({
      ...base,
      start_local: "2026-10-20T10:00:00",
      time_zone: "Somewhere Odd",
    });
    expect(text).toContain(time(new Date(2026, 9, 20, 10, 0)));
    expect(text).toContain("(Somewhere Odd)");
  });

  it("labels invitations, cancellations and replies", () => {
    expect(inviteLabel(base)).toBe("Invitation");
    expect(inviteLabel({ ...base, method: "cancel" })).toBe("Cancelled");
    expect(inviteLabel({ ...base, status: "cancelled" })).toBe("Cancelled");
    expect(inviteLabel({ ...base, method: "reply" })).toBe("Reply");
  });
});

describe("InviteCard", () => {
  beforeEach(() => getEmailInvite.mockReset());
  afterEach(() => {
    cleanup();
    failWith = null;
  });

  it("shows the meeting with a Join link and the organizer", async () => {
    getEmailInvite.mockResolvedValue({
      ...base,
      start: "2026-10-20T19:00:00Z",
      end: "2026-10-20T19:30:00Z",
      location: "Room 4",
      join_url: "https://meet.google.com/abc",
      organizer_name: "Ada",
      organizer_email: "ada@x.com",
    });
    render(<InviteCard emailId={7} />);
    expect(screen.getByText("Loading invitation…")).toBeTruthy();
    expect(await screen.findByText("Design review")).toBeTruthy();
    expect(getEmailInvite).toHaveBeenCalledWith(7);
    expect(screen.getByText("Invitation")).toBeTruthy();
    expect(screen.getByText("Room 4")).toBeTruthy();
    expect(screen.getByText("Organizer: Ada <ada@x.com>")).toBeTruthy();
    const join = screen.getByRole("link", { name: "Join meeting" });
    expect(join.getAttribute("href")).toBe("https://meet.google.com/abc");
    expect(join.getAttribute("rel")).toContain("noopener");
  });

  it("marks a cancellation and offers no Join", async () => {
    getEmailInvite.mockResolvedValue({
      ...base,
      method: "cancel",
      join_url: "https://meet.google.com/abc",
    });
    const { container } = render(<InviteCard emailId={7} />);
    expect(await screen.findByText("Cancelled")).toBeTruthy();
    expect(container.querySelector(".invite-card--cancelled")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Join meeting" })).toBeNull();
  });

  it("shows nothing when the email has no readable invitation", async () => {
    getEmailInvite.mockResolvedValue(null);
    const { container } = render(<InviteCard emailId={7} />);
    await vi.waitFor(() => expect(getEmailInvite).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(container.querySelector(".invite-card")).toBeNull()
    );
  });

  it("says why when the invitation can't be loaded", async () => {
    failWith = new Error("Reconnect your email account to see this invitation");
    render(<InviteCard emailId={7} />);
    expect(
      await screen.findByText(
        "Reconnect your email account to see this invitation"
      )
    ).toBeTruthy();
  });
});

describe("the invitation mark in the list", () => {
  class StubIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  beforeEach(() =>
    vi.stubGlobal("IntersectionObserver", StubIntersectionObserver)
  );
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("marks invitation rows only", () => {
    const rows: EmailItem[] = [
      {
        id: 1,
        subject: "Invitation: Design review",
        sender: "Ada <ada@x.com>",
        created_at: "2026-10-19T09:00:00Z",
        is_read: true,
        is_invite: true,
      },
      {
        id: 2,
        subject: "Lunch?",
        sender: "Bob <bob@x.com>",
        created_at: "2026-10-19T08:00:00Z",
        is_read: true,
      },
    ];
    const { container } = render(
      <EmailList
        emails={rows}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore={false}
        loadMore={() => {}}
        loadingMore={false}
        isListView
        activeFolder="inbox"
      />
    );
    const items = container.querySelectorAll(".email-item");
    expect(
      items[0].querySelectorAll('[aria-label="Meeting invitation"]').length
    ).toBeGreaterThan(0);
    expect(
      items[1].querySelectorAll('[aria-label="Meeting invitation"]').length
    ).toBe(0);
  });
});
