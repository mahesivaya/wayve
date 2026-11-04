// The theme editor opens on just the color grid; every other control waits
// behind Advanced. Only the signed-in user is stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: null }),
}));

import { CustomThemeProvider } from "../../theme/CustomThemeContext";
import ThemeCustomizer from "../../theme/ThemeCustomizer";

const renderEditor = () =>
  render(
    <CustomThemeProvider>
      <ThemeCustomizer />
    </CustomThemeProvider>
  );

const details = () =>
  document.querySelector<HTMLDetailsElement>(
    ".theme-advanced"
  ) as HTMLDetailsElement;

beforeEach(() => {
  window.localStorage.clear();
});

describe("the theme editor", () => {
  it("opens with the grid showing and Advanced closed", () => {
    renderEditor();

    const grid = screen.getByLabelText("Hue and chroma picker");
    expect(details().contains(grid)).toBe(false);
    expect(details().open).toBe(false);
  });

  it.each([
    "Save theme",
    "Randomize theme",
    "Toggle black and white",
    "Theme name",
    "Chroma",
    "Saturation",
    "Contrast",
    "Depth",
  ])("keeps %s inside Advanced", (label) => {
    renderEditor();

    expect(details().contains(screen.getByLabelText(label))).toBe(true);
  });

  it.each(["Copy", "Import", "Revert sliders", "Reset", "Themes", "Font"])(
    "keeps %s inside Advanced",
    (text) => {
      renderEditor();

      expect(
        details().contains(screen.getByText(new RegExp(`^(📋 )?${text}$`)))
      ).toBe(true);
    }
  );

  it("opens Advanced on click", async () => {
    renderEditor();

    await userEvent.click(screen.getByText("Advanced"));

    expect(details().open).toBe(true);
  });
});
