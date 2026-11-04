// System / Light / Dark at the top of Appearance: one tap, saved like any theme,
// and System tracks the device while it's selected.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BW_DARK_INPUT } from "../../theme/blackAndWhite";
import { basicThemeMode } from "../../theme/basicThemeMode";
import { CustomThemeProvider } from "../../theme/CustomThemeContext";
import { parsePersisted, serializePersisted } from "../../theme/themeStorage";
import ThemeModePicker from "../../theme/ThemeModePicker";

const STORAGE_KEY = "wayve-custom-theme-v2";
const mode = () => document.documentElement.getAttribute("data-theme");
const radio = (name: string) =>
  screen.getByRole("radio", { name }) as HTMLInputElement;

// A stand-in for the device's setting that can change while the page is open.
let deviceDark = false;
const listeners = new Set<() => void>();
const setDevice = (dark: boolean) => {
  deviceDark = dark;
  act(() => listeners.forEach((listener) => listener()));
};

const renderPicker = (onPick?: () => void) =>
  render(
    <CustomThemeProvider>
      <ThemeModePicker onPick={onPick} />
    </CustomThemeProvider>
  );

describe("ThemeModePicker", () => {
  beforeEach(() => {
    localStorage.clear();
    listeners.clear();
    deviceDark = false;
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
    window.matchMedia = vi.fn(
      () =>
        ({
          get matches() {
            return deviceDark;
          },
          addEventListener: (_: string, listener: () => void) =>
            listeners.add(listener),
          removeEventListener: (_: string, listener: () => void) =>
            listeners.delete(listener),
        }) as unknown as MediaQueryList
    );
  });

  it("offers the three choices and starts on Light", () => {
    renderPicker();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(radio("Light").checked).toBe(true);
    expect(mode()).toBe("light");
  });

  it("Dark applies and stores the plain black theme", () => {
    renderPicker();
    fireEvent.click(radio("Dark"));
    expect(radio("Dark").checked).toBe(true);
    expect(mode()).toBe("dark");
    expect(parsePersisted(localStorage.getItem(STORAGE_KEY))?.active).toEqual({
      kind: "custom",
      mode: "dark",
      input: BW_DARK_INPUT,
    });
  });

  it("Light goes back to the default", () => {
    renderPicker();
    fireEvent.click(radio("Dark"));
    fireEvent.click(radio("Light"));
    expect(radio("Light").checked).toBe(true);
    expect(mode()).toBe("light");
  });

  it("System follows the device, including changes while open", () => {
    deviceDark = true;
    renderPicker();
    fireEvent.click(radio("System"));
    expect(radio("System").checked).toBe(true);
    expect(mode()).toBe("dark");
    setDevice(false);
    expect(mode()).toBe("light");
    setDevice(true);
    expect(mode()).toBe("dark");
    expect(radio("System").checked).toBe(true);
  });

  it("explains the current choice", () => {
    renderPicker();
    expect(screen.getByText("Always uses the light look.")).toBeTruthy();
    fireEvent.click(radio("System"));
    expect(
      screen.getByText("Switches between light and dark with your device.")
    ).toBeTruthy();
  });

  it("Light and Dark ignore the device", () => {
    renderPicker();
    fireEvent.click(radio("Dark"));
    setDevice(false);
    expect(mode()).toBe("dark");
    fireEvent.click(radio("Light"));
    setDevice(true);
    expect(mode()).toBe("light");
  });

  it("System is remembered and restored", () => {
    localStorage.setItem(
      STORAGE_KEY,
      serializePersisted({ active: { kind: "system" }, library: [], ui: {} })!
    );
    deviceDark = true;
    renderPicker();
    expect(radio("System").checked).toBe(true);
    expect(mode()).toBe("dark");
  });

  it("works where the browser has no matchMedia", () => {
    // @ts-expect-error simulating an environment without it
    delete window.matchMedia;
    renderPicker();
    fireEvent.click(radio("System"));
    expect(mode()).toBe("light");
  });

  it("clears colour overrides when picking, and reports the pick", () => {
    const onPick = vi.fn();
    localStorage.setItem(
      STORAGE_KEY,
      serializePersisted({
        active: { kind: "default" },
        library: [],
        ui: { border: "#111111" },
      })!
    );
    renderPicker(onPick);
    expect(
      screen.getAllByRole("radio").some((r) => (r as HTMLInputElement).checked)
    ).toBe(false);
    fireEvent.click(radio("Dark"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(parsePersisted(localStorage.getItem(STORAGE_KEY))?.ui).toEqual({});
  });
});

describe("basicThemeMode", () => {
  const input = {
    hue: 10,
    chroma: 0.1,
    saturation: 1,
    contrast: 0.6,
    depth: 0,
  };

  it("names the plain choices only", () => {
    expect(basicThemeMode({ kind: "system" }, {})).toBe("system");
    expect(basicThemeMode({ kind: "default" }, {})).toBe("light");
    expect(
      basicThemeMode({ kind: "custom", mode: "dark", input: BW_DARK_INPUT }, {})
    ).toBe("dark");
  });

  it("treats colored themes and presets as none of them", () => {
    expect(
      basicThemeMode({ kind: "custom", mode: "dark", input }, {})
    ).toBeNull();
    expect(basicThemeMode({ kind: "preset", presetId: "rain" }, {})).toBeNull();
    expect(basicThemeMode({ kind: "saved", id: "a" }, {})).toBeNull();
  });
});
