// The Download App menu offers the macOS builds only, and marks one as the
// visitor's own only when they are on a Mac.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DownloadApp from "../../home/DownloadApp";

const openMenu = async (userAgent: string) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("");
  render(<DownloadApp />);
  await userEvent.click(screen.getByRole("button", { name: /Download App/ }));
  return screen.getAllByRole("menuitem");
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DownloadApp", () => {
  it("lists only the macOS builds", async () => {
    const items = await openMenu("Mozilla/5.0 (Macintosh)");

    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      expect.stringContaining("Fluxze-mac-arm64.dmg"),
      expect.stringContaining("Fluxze-mac-x64.dmg"),
    ]);
    expect(screen.queryByText("Windows")).toBeNull();
  });

  it("marks no build as detected on Windows", async () => {
    await openMenu("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    expect(document.querySelector(".is-detected")).toBeNull();
  });
});
