// The desktop app tells the web app when a newer version of itself has downloaded.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const flags = vi.hoisted(() => ({ published: false }));
vi.mock("../../utils/desktop", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get SELF_UPDATING_BUILD_PUBLISHED() {
    return flags.published;
  },
}));

import DesktopUpdateBanner from "../../components/DesktopUpdateBanner";

function installBridge(ready: string | null = null) {
  let notify: (version: string) => void = () => {};
  const unsubscribe = vi.fn();
  const update = {
    getReadyVersion: vi.fn().mockResolvedValue(ready),
    onReady: vi.fn((listener: (version: string) => void) => {
      notify = listener;
      return unsubscribe;
    }),
    install: vi.fn().mockResolvedValue(undefined),
  };
  window.fluxzeDesktop = { isDesktop: true, update };
  return { update, unsubscribe, notify: (v: string) => notify(v) };
}

beforeEach(() => {
  flags.published = false;
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  delete window.fluxzeDesktop;
});

describe("when an update is ready", () => {
  it("offers a restart for one that finished before the page loaded", async () => {
    const { update } = installBridge("0.3.0");
    render(<DesktopUpdateBanner />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Restart to update" })
    );

    expect(update.install).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restarting…" })).toHaveProperty(
      "disabled",
      true
    );
  });

  it("appears when one finishes while the app is open", async () => {
    const { notify } = installBridge();
    render(<DesktopUpdateBanner />);
    await act(async () => {});
    expect(screen.queryByRole("status")).toBeNull();

    act(() => notify("0.3.0"));

    expect(screen.getByText("Update ready")).toBeTruthy();
  });

  it("stays hidden after Later, even across a reload", async () => {
    installBridge("0.3.0");
    const { unmount } = render(<DesktopUpdateBanner />);
    await userEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByRole("status")).toBeNull();

    unmount();
    render(<DesktopUpdateBanner />);
    await act(async () => {});
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("comes back for a newer version after Later", async () => {
    const { notify } = installBridge("0.3.0");
    render(<DesktopUpdateBanner />);
    await userEvent.click(await screen.findByRole("button", { name: "Later" }));

    act(() => notify("0.4.0"));

    expect(screen.getByText("Update ready")).toBeTruthy();
  });

  it("stops listening when it goes away", async () => {
    const { unsubscribe } = installBridge();
    const { unmount } = render(<DesktopUpdateBanner />);
    await act(async () => {});
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe("with nothing to install", () => {
  it("shows nothing when no update is ready", async () => {
    installBridge();
    render(<DesktopUpdateBanner />);
    await act(async () => {});
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows nothing in a browser", () => {
    flags.published = true;
    render(<DesktopUpdateBanner />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("on an install that can't update itself", () => {
  beforeEach(() => {
    window.fluxzeDesktop = { isDesktop: true };
  });

  it("waits until a self-updating build has been published", () => {
    render(<DesktopUpdateBanner />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("then offers the download for either kind of Mac", () => {
    flags.published = true;
    render(<DesktopUpdateBanner />);
    expect(
      screen
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")?.split("/").pop())
    ).toEqual(["Fluxze-mac-arm64.dmg", "Fluxze-mac-x64.dmg"]);
  });
});
