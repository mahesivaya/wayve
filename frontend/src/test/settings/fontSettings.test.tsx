// The app font has its own card on the Appearance page, under Color theme,
// rather than behind the theme editor's Advanced section.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const getFontConfig = vi.fn();
const putMyFont = vi.fn();
vi.mock("../../api/platformUi", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getFontConfig: () => getFontConfig(),
  putMyFont: (key: unknown) => putMyFont(key),
}));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: { id: 1 } }),
}));

import FontSettings from "../../theme/FontSettings";
import { FONT_OPTIONS } from "../../theme/platformFonts";
import { applyTextSize, getTextSize } from "../../theme/textSize";

const config = (extra = {}) => ({
  user: null,
  org: null,
  platform: null,
  can_set_org: false,
  can_set_platform: false,
  ...extra,
});

beforeEach(() => {
  getFontConfig.mockReset().mockResolvedValue(config());
  putMyFont.mockReset().mockResolvedValue({ resolved: null });
});

beforeEach(() => {
  localStorage.clear();
  applyTextSize(100);
});

const group = (name: string) => screen.findByRole("radiogroup", { name });

describe("FontSettings", () => {
  it("shows only the user's own font without org or platform rights", async () => {
    render(<FontSettings />);

    expect(await group("Your font")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Text" })).toBeTruthy();
    expect(
      screen.queryByRole("radiogroup", { name: "Organization font" })
    ).toBeNull();
    expect(
      screen.queryByRole("radiogroup", { name: "Platform font (default)" })
    ).toBeNull();
  });

  it("shows the org and platform fonts to those allowed to set them", async () => {
    getFontConfig.mockResolvedValue(
      config({ can_set_org: true, can_set_platform: true })
    );
    render(<FontSettings />);

    expect(await group("Organization font")).toBeTruthy();
    expect(await group("Platform font (default)")).toBeTruthy();
  });

  it("saves the user's pick", async () => {
    render(<FontSettings />);
    const tiles = await group("Your font");
    const option = FONT_OPTIONS[FONT_OPTIONS.length - 1];

    await userEvent.click(
      within(tiles).getByRole("radio", { name: option.label })
    );

    await waitFor(() => expect(putMyFont).toHaveBeenCalledWith(option.key));
  });

  it("shows every font as a block in its own typeface, with one selected", async () => {
    getFontConfig.mockResolvedValue(config({ user: "inter" }));
    render(<FontSettings />);
    const radios = within(await group("Your font")).getAllByRole("radio");

    expect(radios).toHaveLength(FONT_OPTIONS.length);
    expect(radios.filter((r) => (r as HTMLInputElement).checked)).toHaveLength(
      1
    );
    const inter = screen.getByRole("radio", { name: "Inter" });
    expect((inter as HTMLInputElement).checked).toBe(true);
    expect(inter.closest("label")?.style.fontFamily).toContain("Inter");
  });

  it("offers text sizes as percentages and applies one straight away", async () => {
    render(<FontSettings />);
    const sizes = await group("Text size");
    const root = document.documentElement;

    expect(
      within(sizes)
        .getAllByRole("radio")
        .map((r) => r.closest("label")?.textContent)
    ).toEqual(["90%", "100%", "110%", "125%", "150%"]);
    expect(
      (within(sizes).getByRole("radio", { name: "100%" }) as HTMLInputElement)
        .checked
    ).toBe(true);

    await userEvent.click(within(sizes).getByRole("radio", { name: "125%" }));

    expect(root.style.getPropertyValue("--text-scale")).toBe("1.25");
    expect(root.style.fontSize).toBe("125%");
    expect(getTextSize()).toBe(125);
  });

  it("clears the scale at 100% and ignores a bad stored size", async () => {
    render(<FontSettings />);
    const sizes = await group("Text size");

    await userEvent.click(within(sizes).getByRole("radio", { name: "90%" }));
    await userEvent.click(within(sizes).getByRole("radio", { name: "100%" }));

    expect(
      document.documentElement.style.getPropertyValue("--text-scale")
    ).toBe("");
    localStorage.setItem("wayve-text-size", "999");
    expect(getTextSize()).toBe(100);
  });

  it("shows text size even if the font settings fail to load", async () => {
    getFontConfig.mockRejectedValue(new Error("down"));
    render(<FontSettings />);

    expect(await group("Text size")).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Your font" })).toBeNull();
  });
});
