// A conversation row names everyone who wrote in it, Gmail-style, with your
// own addresses as "me" — not just the newest message's sender, which is
// often you — and bolds only the people with an unread message.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { conversationSenders } from "../../emails/conversation";
import { EmailList } from "../../emails/EmailList";
import type { EmailItem } from "../../emails/types";

const name = (value: string | null | undefined) =>
  (value ?? "").replace(/\s*<.*>$/, "") || "Unknown sender";
const own = ["me@x.com", "Work@Y.com"];
const p = (sender: string, unread = false) => ({ sender, unread });

describe("conversationSenders", () => {
  it("names the others and you as me, in order", () => {
    const result = conversationSenders(
      {
        sender: "Me <me@x.com>",
        participants: [p("Ayana <ayana@x.com>", true), p("Me <me@x.com>")],
      },
      own,
      name
    );
    expect(result.label).toBe("Ayana, me");
    expect(result.lead).toBe("Ayana");
    expect(result.names).toEqual([
      { name: "Ayana", unread: true },
      { name: "me", unread: false },
    ]);
  });

  it("counts every one of your addresses as one me", () => {
    const result = conversationSenders(
      {
        participants: [
          p("Me <me@x.com>"),
          p("Ann <ann@x.com>"),
          p("Me at work <work@y.com>", true),
        ],
      },
      own,
      name
    );
    expect(result.label).toBe("me, Ann");
    // Unread if any of your addresses has an unread message.
    expect(result.names[0]).toEqual({ name: "me", unread: true });
  });

  it("is just me when only you wrote", () => {
    expect(
      conversationSenders({ participants: [p("me@x.com")] }, own, name)
    ).toMatchObject({ label: "me", lead: "me" });
  });

  it("keeps the first and the two latest of a long list", () => {
    const result = conversationSenders(
      {
        participants: [
          p("A <a@x>"),
          p("B <b@x>", true),
          p("C <c@x>"),
          p("D <d@x>", true),
          p("me@x.com"),
        ],
      },
      own,
      name
    );
    expect(result.label).toBe("A … D, me");
    expect(result.gap).toBe(true);
    expect(result.names.map((n) => n.unread)).toEqual([false, true, false]);
  });

  it("names the sender of a row without participants", () => {
    expect(
      conversationSenders({ sender: "Bob <bob@x.com>" }, own, name).label
    ).toBe("Bob");
  });
});

describe("a conversation row", () => {
  afterEach(() => cleanup());

  const renderRow = (row: EmailItem) => {
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
    return render(
      <EmailList
        emails={[row]}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore={false}
        loadMore={async () => {}}
        loadingMore={false}
        isListView
        ownAddresses={own}
      />
    );
  };

  it("shows its senders, bolding only those with unread mail", () => {
    const { container } = renderRow({
      id: 12,
      thread_id: 5,
      subject: "Plans",
      sender: "Me <me@x.com>",
      created_at: "2026-10-07T09:00:00Z",
      is_read: true,
      unread_count: 1,
      message_count: 3,
      participants: [p("Ayana <ayana@x.com>", true), p("Me <me@x.com>")],
    });
    const sender = container.querySelector(".email-list-sender");
    expect(sender?.textContent).toMatch(/^Ayana, me/);
    // The column drops the whole-row weight; each name carries its own.
    expect(sender?.classList.contains("by-person")).toBe(true);
    const bold = Array.from(
      sender?.querySelectorAll(".email-sender-name.is-unread") ?? []
    ).map((el) => el.textContent);
    expect(bold).toEqual(["Ayana"]);
    expect(screen.queryByText(/^Me$/)).toBeNull();
  });

  it("keeps a per-email row's sender as it was", () => {
    const { container } = renderRow({
      id: 3,
      subject: "Hi",
      sender: "Bob <bob@x.com>",
      created_at: "2026-10-07T09:00:00Z",
      is_read: false,
    });
    const sender = container.querySelector(".email-list-sender");
    expect(sender?.textContent).toBe("Bob");
    expect(sender?.classList.contains("by-person")).toBe(false);
  });
});
