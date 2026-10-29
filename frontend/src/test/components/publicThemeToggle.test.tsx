// The public pages' light/dark toggle: dark (black) by default, a click flips
// every public page root on screen, only light is remembered, and the
// signed-in app's theme on <html> is never touched.
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import PublicThemeToggle from "../../components/PublicThemeToggle";
import {
  PUBLIC_THEME_STORAGE_KEY,
  usePublicTheme,
} from "../../theme/usePublicTheme";

function PublicRoot() {
  const { mode } = usePublicTheme();
  return <div data-testid="root" data-public-theme={mode} />;
}

describe("public theme toggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.setAttribute("data-theme", "light");
  });

  it("defaults to dark and switches to light and back", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PublicRoot />
        <PublicThemeToggle />
      </>
    );
    const root = screen.getByTestId("root");
    expect(root.getAttribute("data-public-theme")).toBe("dark");

    await user.click(
      screen.getByRole("button", { name: "Switch to light mode" })
    );
    expect(root.getAttribute("data-public-theme")).toBe("light");
    expect(window.localStorage.getItem(PUBLIC_THEME_STORAGE_KEY)).toBe("light");

    await user.click(
      screen.getByRole("button", { name: "Switch to dark mode" })
    );
    expect(root.getAttribute("data-public-theme")).toBe("dark");
    expect(window.localStorage.getItem(PUBLIC_THEME_STORAGE_KEY)).toBeNull();

    // The signed-in app's theme is separate and untouched.
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("opens on a remembered light pick", () => {
    window.localStorage.setItem(PUBLIC_THEME_STORAGE_KEY, "light");
    render(<PublicRoot />);
    expect(screen.getByTestId("root").getAttribute("data-public-theme")).toBe(
      "light"
    );
  });

  it("labels itself in the mobile menu", () => {
    render(<PublicThemeToggle labelled />);
    expect(screen.getByText("Light mode")).toBeTruthy();
  });
});
