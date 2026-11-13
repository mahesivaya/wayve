// The Download App menu offers the macOS builds and the iPhone app, and marks
// one as the visitor's own only when they are on an Apple device.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DownloadApp, { APP_STORE_URL } from "../../home/DownloadApp";

const openMenu = async (userAgent: string) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("");
  render(<DownloadApp />);
  await userEvent.click(screen.getByRole("button", { name: /Download App/ }));
  return screen.getAllByRole("menuitem");
};

afterEach(() => {
  vi.restoreAllMocks();
  delete window.fluxzeDesktop;
});

describe("DownloadApp", () => {
  // The links go through the backend so each download is counted.
  it("lists the macOS builds and the iPhone app", async () => {
    const items = await openMenu("Mozilla/5.0 (Macintosh)");

    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      expect.stringMatching(/\/api\/desktop\/download\/mac-arm64$/),
      expect.stringMatching(/\/api\/desktop\/download\/mac-x64$/),
      APP_STORE_URL,
    ]);
    expect(screen.queryByText("Windows")).toBeNull();
  });

  // The App Store link opens the store page; it is not a file download.
  it("opens the App Store in a new tab", async () => {
    const items = await openMenu("Mozilla/5.0 (Macintosh)");
    const ios = items[2];

    expect(ios).toHaveTextContent("iPhone");
    expect(ios).toHaveAttribute("target", "_blank");
    expect(ios).not.toHaveAttribute("download");
  });

  // iPhone user agents also say "Mac OS X"; only the iPhone item is marked.
  it("marks the iPhone app as detected on an iPhone", async () => {
    await openMenu(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"
    );

    const detected = document.querySelectorAll(".is-detected");
    expect(detected).toHaveLength(1);
    expect(detected[0]).toHaveAttribute("href", APP_STORE_URL);
  });

  it("marks no build as detected on Windows", async () => {
    await openMenu("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    expect(document.querySelector(".is-detected")).toBeNull();
  });

  it("is hidden inside the desktop app", () => {
    window.fluxzeDesktop = { isDesktop: true };
    render(<DownloadApp />);

    expect(screen.queryByRole("button", { name: /Download App/ })).toBeNull();
  });
});
