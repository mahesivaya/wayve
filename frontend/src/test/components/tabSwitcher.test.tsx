// Holding Ctrl+Option (Ctrl+Alt) shows every open tab, like macOS's Cmd+Tab:
// arrows / Tab move the highlight while held, letting go opens it, Escape
// cancels. Off a Mac it never opens from a text field (AltGr is Ctrl+Alt on
// Windows).
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TabBar from "../../components/tabs/TabBar";
import { STORAGE_KEY } from "../../components/tabs/tabsModel";

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, "platform", {
    value: platform,
    configurable: true,
  });
}

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

const switcher = () => screen.queryByRole("listbox", { name: "Open tabs" });
const highlighted = () =>
  switcher()?.querySelector(
    '[role="option"][aria-selected="true"] .tab-switcher-title'
  )?.textContent;

// Press Ctrl, then Option, on `target` (both held afterwards).
function hold(target: Element = document.body) {
  fireEvent.keyDown(target, { key: "Control", ctrlKey: true });
  fireEvent.keyDown(target, { key: "Alt", ctrlKey: true, altKey: true });
}
const held = { ctrlKey: true, altKey: true };
const release = () =>
  fireEvent.keyUp(document.body, { key: "Alt", ctrlKey: true });

describe("Ctrl+Option tab switcher", () => {
  beforeEach(() => window.localStorage.clear());

  it("shows every open tab with the current one highlighted", () => {
    seed("b");
    renderBar("/b");
    expect(switcher()).toBeNull();
    hold();
    expect(switcher()).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(highlighted()).toBe("B");
  });

  it("moves with the arrows and opens the highlighted tab on release", () => {
    seed("b");
    renderBar("/b");
    hold();
    fireEvent.keyDown(document.body, { key: "ArrowRight", ...held });
    expect(highlighted()).toBe("C");
    release();
    expect(switcher()).toBeNull();
    expect(activeTitle()).toBe("C");
  });

  it("Tab and Shift+Tab move too, wrapping round, and only once per press", () => {
    seed("c");
    renderBar("/c");
    hold();
    // Ctrl is held, so TabBar's own Ctrl+Tab must not also cycle the tabs.
    fireEvent.keyDown(document.body, { key: "Tab", ...held });
    expect(highlighted()).toBe("A");
    expect(activeTitle()).toBe("C");
    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true, ...held });
    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true, ...held });
    expect(highlighted()).toBe("B");
    release();
    expect(activeTitle()).toBe("B");
  });

  it("Escape closes it without switching", () => {
    seed("a");
    renderBar("/a");
    hold();
    fireEvent.keyDown(document.body, { key: "ArrowRight", ...held });
    fireEvent.keyDown(document.body, { key: "Escape", ...held });
    expect(switcher()).toBeNull();
    release();
    expect(activeTitle()).toBe("A");
  });

  it("closes without switching when the window loses focus", () => {
    seed("a");
    renderBar("/a");
    hold();
    fireEvent.keyDown(document.body, { key: "ArrowRight", ...held });
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(switcher()).toBeNull();
    expect(activeTitle()).toBe("A");
  });

  it("opens the tab clicked while holding the keys", () => {
    seed("a");
    renderBar("/a");
    hold();
    const option = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.startsWith("C"));
    fireEvent.mouseDown(option as HTMLElement);
    expect(switcher()).toBeNull();
    expect(activeTitle()).toBe("C");
  });

  it("off a Mac, does not open from a text field (AltGr is Ctrl+Alt)", () => {
    setPlatform("Win32");
    seed("a");
    renderBar("/a");
    hold(screen.getByLabelText("field"));
    expect(switcher()).toBeNull();
  });

  it("on a Mac, opens from a text field too", () => {
    setPlatform("MacIntel");
    seed("a");
    renderBar("/a");
    hold(screen.getByLabelText("field"));
    expect(switcher()).toBeTruthy();
  });

  it("does not open with a single tab, or with Cmd or Shift also held", () => {
    seed("a", ["a"]);
    const { unmount } = renderBar("/a");
    hold();
    expect(switcher()).toBeNull();
    unmount();

    window.localStorage.clear();
    seed("a");
    renderBar("/a");
    fireEvent.keyDown(document.body, { key: "Alt", ...held, metaKey: true });
    fireEvent.keyDown(document.body, { key: "Alt", ...held, shiftKey: true });
    expect(switcher()).toBeNull();
  });
});
