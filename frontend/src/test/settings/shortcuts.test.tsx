// Settings → Shortcuts lists every keyboard shortcut, with platform key names
// (⌘ on a Mac, Ctrl elsewhere) and a Desktop app / Web browser toggle that
// separates what only works in the desktop app.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const desktop = vi.hoisted(() => ({ value: false }));
vi.mock("../../utils/desktop", () => ({ isDesktopApp: () => desktop.value }));
vi.mock("../../components/useIsNarrow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/useIsNarrow")>()),
  useIsNarrow: () => false,
}));

import Shortcuts from "../../settings/Shortcuts";

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, "platform", {
    value: platform,
    configurable: true,
  });
}

describe("Settings → Shortcuts", () => {
  afterEach(() => {
    desktop.value = false;
  });

  it("lists the tab, split, email and writing shortcuts", () => {
    setPlatform("MacIntel");
    render(<Shortcuts />);
    for (const title of ["Tabs", "Split view", "Email", "Writing messages"]) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }
    expect(screen.getByText("Next tab")).toBeTruthy();
    expect(screen.getByText("Reply all")).toBeTruthy();
  });

  it("shows Mac key symbols on a Mac", () => {
    setPlatform("MacIntel");
    render(<Shortcuts />);
    expect(screen.getByLabelText("⌘ →")).toBeTruthy();
  });

  it("shows Ctrl elsewhere", () => {
    setPlatform("Win32");
    render(<Shortcuts />);
    expect(screen.getByLabelText("Ctrl →")).toBeTruthy();
  });

  it("opens on the Web browser view in a browser, without desktop-only keys", () => {
    setPlatform("MacIntel");
    render(<Shortcuts />);
    const browser = screen.getByRole("button", { name: "Web browser" });
    expect(browser.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.queryByRole("heading", { name: "Desktop app window" })
    ).toBeNull();
    expect(screen.queryByText("Next tab, looping round")).toBeNull();
    expect(screen.queryByText("Desktop app only")).toBeNull();
    // Shared shortcuts are still listed.
    expect(screen.getByText("Show all open tabs")).toBeTruthy();
  });

  it("opens on the Desktop app view in the app, tagging desktop-only keys", () => {
    setPlatform("MacIntel");
    desktop.value = true;
    render(<Shortcuts />);
    const app = screen.getByRole("button", { name: "Desktop app" });
    expect(app.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("heading", { name: "Desktop app window" })
    ).toBeTruthy();
    const row = screen.getByText("Next tab, looping round");
    expect(row.querySelector(".shortcuts-badge")?.textContent).toBe(
      "Desktop app only"
    );
    // A shortcut that works everywhere carries no tag.
    expect(
      screen.getByText("Show all open tabs").querySelector(".shortcuts-badge")
    ).toBeNull();
  });

  it("the toggle switches between the two lists", () => {
    setPlatform("MacIntel");
    render(<Shortcuts />);
    fireEvent.click(screen.getByRole("button", { name: "Desktop app" }));
    expect(
      screen.getByRole("heading", { name: "Desktop app window" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Web browser" }));
    expect(
      screen.queryByRole("heading", { name: "Desktop app window" })
    ).toBeNull();
  });
});
