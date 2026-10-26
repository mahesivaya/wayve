// The Appearance card on the General settings page (narrow screens): Light and
// Dark apply in one tap, Custom opens the theme editor.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom"
    );
  return { ...actual, useNavigate: () => navigate };
});

import AppearanceCard from "../../profile/AppearanceCard";
import { CustomThemeProvider } from "../../theme/CustomThemeContext";

const renderCard = () =>
  render(
    <MemoryRouter>
      <CustomThemeProvider>
        <AppearanceCard />
      </CustomThemeProvider>
    </MemoryRouter>
  );

const pressed = (name: string) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed");

describe("Appearance card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("starts on Light, the app default", () => {
    renderCard();
    expect(pressed("Light")).toBe("true");
    expect(pressed("Dark")).toBe("false");
    expect(pressed("Custom")).toBe("false");
  });

  it("switches between Dark and Light in place", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: "Dark" }));
    expect(pressed("Dark")).toBe("true");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // Dark is plain black: a near-black canvas with no hue (chroma 0), not a
    // tinted dark preset.
    const canvas =
      document.documentElement.style.getPropertyValue("--color-canvas");
    expect(canvas).toMatch(/^oklch\(0\.0\d+ 0\.000 /);

    await user.click(screen.getByRole("button", { name: "Light" }));
    expect(pressed("Light")).toBe("true");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens the theme editor from Custom", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: "Custom" }));
    expect(navigate).toHaveBeenCalledWith("/appearance");
  });
});
