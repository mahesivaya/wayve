import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MessageReactions from "../../chat/components/MessageReactions";
import type { ChatMessage } from "../../api/chat";

const ME = 1;

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  message_id: 10,
  sender_id: 2,
  content: "hi",
  status: "sent",
  created_at: new Date().toISOString(),
  ...over,
});

const renderRow = (msg: ChatMessage, onToggle = vi.fn()) => {
  render(
    <MessageReactions message={msg} currentUserId={ME} onToggle={onToggle} />
  );
  return onToggle;
};

describe("MessageReactions", () => {
  it("renders a pill per emoji with its count", () => {
    renderRow(
      message({
        reactions: [
          { emoji: "👍", user_ids: [2, 3] },
          { emoji: "🎉", user_ids: [3] },
        ],
      })
    );
    expect(screen.getByRole("button", { name: "👍 2 reactions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "🎉 1 reaction" })).toBeTruthy();
  });

  it("marks the pill pressed when the viewer is among the reactors", () => {
    renderRow(message({ reactions: [{ emoji: "👍", user_ids: [ME, 3] }] }));
    const pill = screen.getByRole("button", { name: "👍 2 reactions" });
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    expect(pill.className).toContain("reaction-pill--mine");
  });

  it("leaves the pill unpressed when the viewer has not reacted", () => {
    renderRow(message({ reactions: [{ emoji: "👍", user_ids: [3] }] }));
    const pill = screen.getByRole("button", { name: "👍 1 reaction" });
    expect(pill.getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles when a pill is clicked", async () => {
    const onToggle = renderRow(
      message({ reactions: [{ emoji: "👍", user_ids: [3] }] })
    );
    await userEvent.click(
      screen.getByRole("button", { name: "👍 1 reaction" })
    );
    // is_channel false — this message has no channel_id, so it's a DM.
    expect(onToggle).toHaveBeenCalledWith(10, false, "👍");
  });

  it("reports a channel message as is_channel", async () => {
    const onToggle = renderRow(
      message({ channel_id: 7, reactions: [{ emoji: "🔥", user_ids: [3] }] })
    );
    await userEvent.click(
      screen.getByRole("button", { name: "🔥 1 reaction" })
    );
    expect(onToggle).toHaveBeenCalledWith(10, true, "🔥");
  });

  it("adds a new reaction from the picker", async () => {
    const onToggle = renderRow(message());
    await userEvent.click(screen.getByRole("button", { name: "Add reaction" }));
    await userEvent.click(screen.getByRole("button", { name: "rocket" }));
    expect(onToggle).toHaveBeenCalledWith(10, false, "🚀");
    // Picking closes the picker.
    expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
  });

  it("renders nothing for an optimistic message that has no server id yet", () => {
    const { container } = render(
      <MessageReactions
        message={message({ message_id: undefined })}
        currentUserId={ME}
        onToggle={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});
