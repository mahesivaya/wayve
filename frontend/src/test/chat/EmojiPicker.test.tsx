import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import EmojiPicker from "../../chat/components/EmojiPicker";
import { searchEmojis } from "../../chat/emoji";

// The picker checks clicks against its anchor, which in the composer wraps both
// the popover and the button that opens it.
const renderPicker = (onSelect = vi.fn(), onClose = vi.fn()) => {
  const anchorRef = createRef<HTMLDivElement>();
  render(
    <div ref={anchorRef}>
      <EmojiPicker
        anchorRef={anchorRef}
        onSelect={onSelect}
        onClose={onClose}
      />
    </div>
  );
  return { onSelect, onClose };
};

describe("EmojiPicker", () => {
  it("hands the chosen glyph to onSelect", async () => {
    const { onSelect } = renderPicker();
    await userEvent.click(screen.getByRole("button", { name: "party popper" }));
    expect(onSelect).toHaveBeenCalledWith("🎉");
  });

  it("filters the grid by name or keyword", async () => {
    renderPicker();
    await userEvent.type(screen.getByLabelText("Search emoji"), "rocket");
    expect(screen.getByRole("button", { name: "rocket" })).toBeTruthy();
    // A non-matching emoji from another category is gone while searching.
    expect(screen.queryByRole("button", { name: "party popper" })).toBeNull();
  });

  it("shows an empty state when nothing matches", async () => {
    renderPicker();
    await userEvent.type(screen.getByLabelText("Search emoji"), "zzzznope");
    expect(screen.getByText(/No emoji for/)).toBeTruthy();
  });

  it("closes on Escape", async () => {
    const { onClose } = renderPicker();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on a click outside the anchor", async () => {
    const { onClose } = renderPicker();
    await userEvent.click(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it("stays open when the click is inside the anchor", async () => {
    const { onClose } = renderPicker();
    await userEvent.click(screen.getByLabelText("Search emoji"));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("searchEmojis", () => {
  it("matches keywords that aren't in the emoji's name", () => {
    // "ship" is a keyword on 🚀 and 📦; neither is named "ship".
    const chars = searchEmojis("ship").map((e) => e.char);
    expect(chars).toContain("🚀");
    expect(chars).toContain("📦");
  });

  it("returns nothing for a blank query so the caller shows all categories", () => {
    expect(searchEmojis("   ")).toEqual([]);
  });
});
