// The web app only clears room for the window controls when the shell says it
// hides the native title bar, so older desktop installs keep the normal layout.
import { afterEach, describe, expect, it } from "vitest";

import { applyRuntimeClass } from "../../utils/desktop";

const root = document.documentElement;
const strips = () => document.querySelectorAll(".desktop-drag-strip").length;

describe("desktop title bar", () => {
  afterEach(() => {
    delete window.fluxzeDesktop;
    root.className = "";
    document.querySelector(".desktop-drag-strip")?.remove();
  });

  it("clears room and adds a drag strip when the shell hides the bar", () => {
    window.fluxzeDesktop = {
      isDesktop: true,
      platform: "darwin",
      titleBarInset: true,
    };
    applyRuntimeClass();
    expect(root.classList.contains("is-titlebar-inset")).toBe(true);
    expect(strips()).toBe(1);
    expect(document.body.firstElementChild?.className).toBe(
      "desktop-drag-strip"
    );
  });

  it("adds only one strip if it runs twice", () => {
    window.fluxzeDesktop = { isDesktop: true, titleBarInset: true };
    applyRuntimeClass();
    applyRuntimeClass();
    expect(strips()).toBe(1);
  });

  it("leaves an older install that doesn't report it alone", () => {
    window.fluxzeDesktop = { isDesktop: true, platform: "darwin" };
    applyRuntimeClass();
    expect(root.classList.contains("is-desktop")).toBe(true);
    expect(root.classList.contains("is-titlebar-inset")).toBe(false);
    expect(strips()).toBe(0);
  });

  it("leaves other platforms alone", () => {
    window.fluxzeDesktop = {
      isDesktop: true,
      platform: "win32",
      titleBarInset: false,
    };
    applyRuntimeClass();
    expect(root.classList.contains("is-titlebar-inset")).toBe(false);
    expect(strips()).toBe(0);
  });

  it("leaves the browser alone", () => {
    applyRuntimeClass();
    expect(root.classList.contains("is-web")).toBe(true);
    expect(root.classList.contains("is-titlebar-inset")).toBe(false);
    expect(strips()).toBe(0);
  });
});
