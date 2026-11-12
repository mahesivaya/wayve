// Chat sidebar rows: the ⋮ button opens a row menu that shows "TBD" for now.
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ConversationRow from "../../chat/components/ConversationRow";

function renderRow() {
  return render(
    <ConversationRow label="#general">
      <button type="button">general</button>
    </ConversationRow>
  );
}

describe("ConversationRow menu", () => {
  it("shows TBD when the ⋮ button is clicked", () => {
    renderRow();
    expect(screen.queryByText("TBD")).toBeNull();

    fireEvent.click(screen.getByLabelText("More options for #general"));

    const menu = screen.getByRole("dialog", { name: "Options for #general" });
    expect(menu.textContent).toBe("TBD");
  });

  it("closes on Escape, an outside click, or a second ⋮ click", () => {
    renderRow();
    const kebab = screen.getByLabelText("More options for #general");

    fireEvent.click(kebab);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("TBD")).toBeNull();

    fireEvent.click(kebab);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("TBD")).toBeNull();

    fireEvent.click(kebab);
    fireEvent.click(kebab);
    expect(screen.queryByText("TBD")).toBeNull();
  });
});
