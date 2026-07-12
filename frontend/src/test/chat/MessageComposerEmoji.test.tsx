import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import MessageComposer from "../../chat/components/MessageComposer";
import type { Conversation } from "../../chat/types";

const CONVERSATION: Conversation = {
  type: "user",
  user: { id: 2, email: "peer@example.com" },
};

// The composer's input is controlled by Chat.tsx, so drive it from a host that
// owns the value the same way — otherwise the caret splice has nothing to
// write back into.
function Host({ initial = "" }: { initial?: string }) {
  const [input, setInput] = useState(initial);
  return (
    <MessageComposer
      conversation={CONVERSATION}
      canChat
      isConnected
      title="peer@example.com"
      input={input}
      onInputChange={setInput}
      onSend={vi.fn()}
    />
  );
}

const openPicker = async () =>
  userEvent.click(screen.getByRole("button", { name: "Emoji" }));

describe("MessageComposer emoji picker", () => {
  it("opens and closes from the toggle button", async () => {
    render(<Host />);
    expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
    await openPicker();
    expect(screen.getByRole("dialog", { name: "Emoji picker" })).toBeTruthy();
    // Clicking the toggle again closes it — the picker's outside-click dismiss
    // treats the button as inside the anchor, so it must not reopen.
    await openPicker();
    expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
  });

  it("appends the emoji to an empty message and closes", async () => {
    render(<Host />);
    await openPicker();
    await userEvent.click(screen.getByRole("button", { name: "party popper" }));
    expect(screen.getByRole("textbox")).toHaveProperty("value", "🎉");
    expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
  });

  it("inserts at the caret rather than at the end", async () => {
    render(<Host initial="ab" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // Put the caret between the two characters.
    await userEvent.click(textarea);
    textarea.setSelectionRange(1, 1);

    await openPicker();
    await userEvent.click(screen.getByRole("button", { name: "fire" }));
    expect(textarea.value).toBe("a🔥b");
  });

  it("replaces the selected text", async () => {
    render(<Host initial="hello world" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.click(textarea);
    textarea.setSelectionRange(0, 5); // select "hello"

    await openPicker();
    await userEvent.click(screen.getByRole("button", { name: "thumbs up" }));
    expect(textarea.value).toBe("👍 world");
  });
});
