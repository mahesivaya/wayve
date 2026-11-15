// Cmd/Ctrl+Left and Cmd/Ctrl+Right open the tab to the left / right, stopping
// at the first / last tab — but never while the user is typing, where those
// keys move the caret to the line's start / end.
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TabBar from "../../components/tabs/TabBar";
import { STORAGE_KEY } from "../../components/tabs/tabsModel";

function seed(activeId: string, tabs = ["a", "b", "c"]) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      tabs: tabs.map((id) => ({ id, path: `/${id}`, title: id.toUpperCase() })),
      activeId,
    })
  );
}

function renderBar(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TabBar />
      <input aria-label="field" />
    </MemoryRouter>
  );
}

const activeTitle = () =>
  screen
    .getAllByRole("tab")
    .find((t) => t.getAttribute("aria-selected") === "true")
    ?.getAttribute("title");

describe("Cmd/Ctrl+arrow tab switching", () => {
  beforeEach(() => window.localStorage.clear());

  it("Cmd+Right opens the next tab and Cmd+Left the previous one", () => {
    seed("b");
    renderBar("/b");
    expect(activeTitle()).toBe("B");

    fireEvent.keyDown(document.body, { key: "ArrowRight", metaKey: true });
    expect(activeTitle()).toBe("C");

    fireEvent.keyDown(document.body, { key: "ArrowLeft", metaKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowLeft", metaKey: true });
    expect(activeTitle()).toBe("A");
  });

  it("stops at the last tab going right", () => {
    seed("c");
    renderBar("/c");
    fireEvent.keyDown(document.body, { key: "ArrowRight", metaKey: true });
    expect(activeTitle()).toBe("C");
  });

  it("stops at the first tab going left", () => {
    seed("a");
    renderBar("/a");
    fireEvent.keyDown(document.body, { key: "ArrowLeft", metaKey: true });
    expect(activeTitle()).toBe("A");
  });

  it("Ctrl+Tab still wraps from the last tab to the first", () => {
    seed("c");
    renderBar("/c");
    fireEvent.keyDown(document.body, { key: "Tab", ctrlKey: true });
    expect(activeTitle()).toBe("A");
  });

  it("Ctrl works too (Windows / Linux)", () => {
    seed("a");
    renderBar("/a");
    fireEvent.keyDown(document.body, { key: "ArrowRight", ctrlKey: true });
    expect(activeTitle()).toBe("B");
  });

  it("leaves the keys to a text field the user is typing in", () => {
    seed("b");
    renderBar("/b");
    const field = screen.getByLabelText("field");
    const event = fireEvent.keyDown(field, {
      key: "ArrowRight",
      metaKey: true,
    });
    expect(event).toBe(true); // not prevented: the caret moves as usual
    expect(activeTitle()).toBe("B");
  });

  it("ignores Shift and Alt variants and plain arrows", () => {
    seed("b");
    renderBar("/b");
    fireEvent.keyDown(document.body, {
      key: "ArrowRight",
      metaKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(document.body, {
      key: "ArrowRight",
      metaKey: true,
      altKey: true,
    });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(activeTitle()).toBe("B");
  });

  it("does nothing with a single tab", () => {
    seed("a", ["a"]);
    renderBar("/a");
    const event = fireEvent.keyDown(document.body, {
      key: "ArrowRight",
      metaKey: true,
    });
    expect(event).toBe(true);
    expect(activeTitle()).toBe("A");
  });
});
