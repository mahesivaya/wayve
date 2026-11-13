import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import PersonalChatList from "../../chat/components/PersonalChatList";
import type { ChatConversationSummary, ChatUser } from "../../api/chat";
import type { Conversation } from "../../chat/types";

const ALICE: ChatUser = { id: 2, email: "alice@example.com" };
const BOB: ChatUser = { id: 3, email: "bob@example.com" };

// Alice has DM history (so she shows under Recent); Bob has none.
const SUMMARY: ChatConversationSummary = {
  total_unread: 0,
  conversations: [
    {
      user_id: ALICE.id,
      unread_count: 0,
      last_message_at: new Date().toISOString(),
    },
  ],
};

const renderList = (
  section: "recent" | "people",
  summary: ChatConversationSummary = SUMMARY,
  selectedConversation: Conversation | null = null
) =>
  render(
    <PersonalChatList
      users={[ALICE, BOB]}
      selectedConversation={selectedConversation}
      onSelect={vi.fn()}
      summary={summary}
      presence={new Map()}
      section={section}
    />
  );

describe("PersonalChatList — DM list", () => {
  it("lists only the people you have a DM with", () => {
    renderList("people");
    expect(screen.getByText(ALICE.email)).toBeTruthy();
    expect(screen.queryByText(BOB.email)).toBeNull();
  });

  it("keeps the person you have open listed before their first message", () => {
    renderList("people", SUMMARY, { type: "user", user: BOB });
    expect(screen.getByText(ALICE.email)).toBeTruthy();
    expect(screen.getByText(BOB.email)).toBeTruthy();
  });

  it("says so when you have no DMs yet", () => {
    renderList("people", { total_unread: 0, conversations: [] });
    expect(screen.getByText("No direct messages yet.")).toBeTruthy();
    expect(screen.queryByText(ALICE.email)).toBeNull();
  });

  it("lists DMs alphabetically, not by recency", () => {
    // Bob's DM is newer, but Alice still comes first.
    renderList("people", {
      total_unread: 0,
      conversations: [
        {
          user_id: ALICE.id,
          unread_count: 0,
          last_message_at: "2026-11-01T00:00:00Z",
        },
        {
          user_id: BOB.id,
          unread_count: 0,
          last_message_at: "2026-11-12T00:00:00Z",
        },
      ],
    });
    const names = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((t) => t.includes("@"));
    expect(names[0]).toContain(ALICE.email);
    expect(names[1]).toContain(BOB.email);
  });

  it("keeps the directory row quiet — no timestamp, that's Recent's job", () => {
    renderList("people");
    expect(screen.queryByText(/just now|ago/i)).toBeNull();
  });

  it("still surfaces a DMed user under Recent", () => {
    renderList("recent");
    expect(screen.getByText("Recent")).toBeTruthy();
    expect(screen.getByText(ALICE.email)).toBeTruthy();
    // Bob has no history, so he is not a "recent" conversation.
    expect(screen.queryByText(BOB.email)).toBeNull();
  });

  it("shows the unread badge on the Recent row only", () => {
    const unreadSummary: ChatConversationSummary = {
      total_unread: 4,
      conversations: [
        {
          user_id: ALICE.id,
          unread_count: 4,
          last_message_at: new Date().toISOString(),
        },
      ],
    };
    const props = {
      users: [ALICE, BOB],
      selectedConversation: null,
      onSelect: vi.fn(),
      summary: unreadSummary,
      presence: new Map(),
    };

    const recent = render(<PersonalChatList {...props} section="recent" />);
    expect(screen.getByLabelText("4 unread")).toBeTruthy();
    recent.unmount();

    render(<PersonalChatList {...props} section="people" />);
    // Alice is still in the directory, but the badge lives on her Recent row.
    expect(screen.getByText(ALICE.email)).toBeTruthy();
    expect(screen.queryByLabelText("4 unread")).toBeNull();
  });
});
