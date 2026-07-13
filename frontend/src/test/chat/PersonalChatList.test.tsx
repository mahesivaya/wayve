import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import PersonalChatList from "../../chat/components/PersonalChatList";
import type { ChatConversationSummary, ChatUser } from "../../api/chat";

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

const renderList = (section: "recent" | "people") =>
  render(
    <PersonalChatList
      users={[ALICE, BOB]}
      selectedConversation={null}
      onSelect={vi.fn()}
      summary={SUMMARY}
      presence={new Map()}
      section={section}
    />
  );

describe("PersonalChatList — Users directory", () => {
  it("keeps a user you have DMed in the Users directory", () => {
    renderList("people");
    // The regression: Alice used to disappear from Users the moment she had a
    // last_message_at, leaving Recent as the only place to find her.
    expect(screen.getByText(ALICE.email)).toBeTruthy();
    expect(screen.getByText(BOB.email)).toBeTruthy();
  });

  it("lists the directory alphabetically, not by recency", () => {
    renderList("people");
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
