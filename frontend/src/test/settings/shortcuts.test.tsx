// Settings → Shortcuts lists every keyboard shortcut, with platform key names
// (⌘ on a Mac, Ctrl elsewhere) and the desktop-menu keys only in the app.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const desktop = vi.hoisted(() => ({ value: false }));
vi.mock("../../utils/desktop", () => ({ isDesktopApp: () => desktop.value }));
vi.mock("../../components/useIsNarrow", () => ({ useIsNarrow: () => false }));

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

  it("shows the desktop menu keys only in the desktop app", () => {
    setPlatform("MacIntel");
    const { unmount } = render(<Shortcuts />);
    expect(screen.queryByRole("heading", { name: "Desktop app" })).toBeNull();
    unmount();

    desktop.value = true;
    render(<Shortcuts />);
    expect(screen.getByRole("heading", { name: "Desktop app" })).toBeTruthy();
  });
});
