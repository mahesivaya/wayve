// Chat sidebar rows: a channel's ⋮ button opens a menu that copies the
// channel's link. A DM row has no link, so no menu.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../utils/clipboard", () => ({
  copyText: vi.fn().mockResolvedValue(true),
}));

import ConversationRow from "../../chat/components/ConversationRow";
import { channelLink } from "../../chat/utils";
import { copyText } from "../../utils/clipboard";

function renderRow() {
  return render(
    <ConversationRow label="#general" link={channelLink(42)}>
      <button type="button">general</button>
    </ConversationRow>
  );
}

describe("ConversationRow menu", () => {
  afterEach(() => vi.clearAllMocks());

  it("links to the channel by its number", () => {
    expect(channelLink(42)).toBe(`${window.location.origin}/chat?c=42`);
  });

  it("copies the channel link from the ⋮ menu", async () => {
    renderRow();
    expect(screen.queryByText("Copy channel link")).toBeNull();

    fireEvent.click(screen.getByLabelText("More options for #general"));
    const menu = screen.getByRole("menu", { name: "Options for #general" });
    expect(menu.textContent).toBe("Copy channel link");

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy channel link" })
    );

    expect(copyText).toHaveBeenCalledWith(channelLink(42));
    expect(await screen.findByText("Link copied")).toBeTruthy();
  });

  it("says nothing was copied when the copy fails", async () => {
    (copyText as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      false
    );
    renderRow();
    fireEvent.click(screen.getByLabelText("More options for #general"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy channel link" })
    );

    await Promise.resolve();
    expect(screen.queryByText("Link copied")).toBeNull();
    expect(screen.getByText("Copy channel link")).toBeTruthy();
  });

  it("closes on Escape, an outside click, or a second ⋮ click", () => {
    renderRow();
    const kebab = screen.getByLabelText("More options for #general");

    fireEvent.click(kebab);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Copy channel link")).toBeNull();

    fireEvent.click(kebab);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Copy channel link")).toBeNull();

    fireEvent.click(kebab);
    fireEvent.click(kebab);
    expect(screen.queryByText("Copy channel link")).toBeNull();
  });

  it("gives a row without a link, a DM, no menu", () => {
    render(
      <ConversationRow label="sam@example.com">
        <button type="button">sam</button>
      </ConversationRow>
    );
    expect(screen.getByText("sam")).toBeTruthy();
    expect(screen.queryByLabelText(/More options/)).toBeNull();
  });
});
