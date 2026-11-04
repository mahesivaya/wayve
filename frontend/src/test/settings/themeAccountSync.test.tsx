// The account's saved theme decides what a login shows, whatever the device
// happens to hold, and only a real change is saved back to the account.
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: null as unknown }));
const putTheme = vi.hoisted(() => vi.fn(async (_theme: string | null) => ({})));

vi.mock("../../auth/useAuth", () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock("../../api/profile", () => ({ putTheme }));

import { CustomThemeProvider } from "../../theme/CustomThemeContext";
import { BW_DARK_INPUT, BW_LIGHT_INPUT } from "../../theme/blackAndWhite";
import ThemeSyncBridge from "../../theme/ThemeSyncBridge";
import {
  forgetDeviceTheme,
  MODE_STORAGE_KEY,
  parsePersisted,
  STORAGE_KEY,
} from "../../theme/themeStorage";
import { useCustomTheme } from "../../theme/useCustomTheme";

const blob = (hue: number, mode: "light" | "dark") =>
  JSON.stringify({
    v: 2,
    active: {
      kind: "custom",
      mode,
      input: { hue, chroma: 0.1, saturation: 1, contrast: 0.6, depth: 0 },
    },
    library: [],
    ui: {},
  });
const ACCOUNT = blob(10, "dark");
const LEFTOVER = blob(120, "light");

function Reset() {
  const { resetToDefault } = useCustomTheme();
  return <button onClick={resetToDefault}>reset</button>;
}

const tree = () => (
  <CustomThemeProvider>
    <ThemeSyncBridge>
      <Reset />
    </ThemeSyncBridge>
  </CustomThemeProvider>
);

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });

// AuthContext's order on a fresh login: a user from the JWT, then /api/me.
async function freshLogin(themeJson: string | null) {
  auth.user = null;
  const { rerender } = render(tree());
  auth.user = { id: 90 };
  rerender(tree());
  await settle();
  auth.user = { id: 90, theme_json: themeJson };
  rerender(tree());
  await settle();
  return rerender;
}

const mode = () => document.documentElement.getAttribute("data-theme");
const stored = () => localStorage.getItem(STORAGE_KEY);

describe("theme follows the account", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    putTheme.mockClear();
    auth.user = null;
    document.documentElement.removeAttribute("data-theme");
    return () => vi.useRealTimers();
  });

  it("applies the account's theme on a fresh login", async () => {
    await freshLogin(ACCOUNT);
    expect(mode()).toBe("dark");
    expect(stored()).toBe(ACCOUNT);
    expect(putTheme).not.toHaveBeenCalled();
  });

  it("replaces a theme left on the device and doesn't save it", async () => {
    localStorage.setItem(STORAGE_KEY, LEFTOVER);
    await freshLogin(ACCOUNT);
    expect(mode()).toBe("dark");
    expect(stored()).toBe(ACCOUNT);
    expect(putTheme).not.toHaveBeenCalled();
  });

  it("gives an account with no theme the default, not the device's", async () => {
    localStorage.setItem(STORAGE_KEY, LEFTOVER);
    localStorage.setItem(MODE_STORAGE_KEY, "dark");
    await freshLogin(null);
    expect(mode()).toBe("light");
    expect(stored()).toBeNull();
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBeNull();
    expect(putTheme).not.toHaveBeenCalled();
  });

  it("saves nothing while only the JWT user is known", async () => {
    localStorage.setItem(STORAGE_KEY, LEFTOVER);
    render(tree());
    auth.user = { id: 90 };
    render(tree());
    await settle();
    expect(putTheme).not.toHaveBeenCalled();
    expect(stored()).toBe(LEFTOVER);
  });

  it("applies the account's theme on a reload with a live session", async () => {
    auth.user = { id: 90, theme_json: ACCOUNT };
    render(tree());
    await settle();
    expect(mode()).toBe("dark");
    expect(putTheme).not.toHaveBeenCalled();
  });

  it("doesn't re-apply a theme when /api/me is fetched again", async () => {
    const rerender = await freshLogin(ACCOUNT);
    auth.user = { id: 90, theme_json: LEFTOVER };
    rerender(tree());
    await settle();
    expect(stored()).toBe(ACCOUNT);
    expect(putTheme).not.toHaveBeenCalled();
  });

  it("still saves a change the user makes after login", async () => {
    await freshLogin(ACCOUNT);
    act(() => screen.getByRole("button", { name: "reset" }).click());
    await settle();
    expect(putTheme).toHaveBeenCalledTimes(1);
    expect(putTheme).toHaveBeenCalledWith(null);
    expect(mode()).toBe("light");
  });

  it("switches theme when a different account takes over", async () => {
    const rerender = await freshLogin(ACCOUNT);
    auth.user = null;
    rerender(tree());
    await settle();
    auth.user = { id: 91, theme_json: null };
    rerender(tree());
    await settle();
    expect(mode()).toBe("light");
    expect(stored()).toBeNull();
    expect(putTheme).not.toHaveBeenCalled();
  });
});

describe("forgetDeviceTheme", () => {
  it("clears the theme and the pre-paint mode", () => {
    localStorage.setItem(STORAGE_KEY, ACCOUNT);
    localStorage.setItem(MODE_STORAGE_KEY, "dark");
    localStorage.setItem("unrelated", "kept");
    forgetDeviceTheme();
    expect(stored()).toBeNull();
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("kept");
  });
});

describe("removed presets", () => {
  it.each([
    ['{"kind":"preset","presetId":"default-light"}'],
    ['{"v":2,"active":{"kind":"preset","presetId":"default-light"}}'],
  ])("default-light becomes the default: %s", (json) => {
    expect(parsePersisted(json)?.active).toEqual({ kind: "default" });
  });

  it("default-dark becomes the plain black theme, so it stays dark", () => {
    expect(
      parsePersisted(
        '{"v":2,"active":{"kind":"preset","presetId":"default-dark"}}'
      )?.active
    ).toEqual({ kind: "custom", mode: "dark", input: BW_DARK_INPUT });
  });

  it.each([
    { mode: "light", depth: 0.04, input: BW_LIGHT_INPUT },
    { mode: "dark", depth: 0.05, input: BW_DARK_INPUT },
  ])(
    "a stored $mode black and white theme picks up the separate levels",
    ({ mode, depth, input }) => {
      const active = { kind: "custom", mode, input: { ...input, depth } };
      expect(parsePersisted(JSON.stringify({ v: 2, active }))?.active).toEqual({
        kind: "custom",
        mode,
        input,
      });
    }
  );

  it("keeps a black and white depth set by hand", () => {
    const active = {
      kind: "custom",
      mode: "dark",
      input: { ...BW_DARK_INPUT, depth: 0.02 },
    };
    expect(parsePersisted(JSON.stringify({ v: 2, active }))?.active).toEqual(
      active
    );
  });

  it("keeps saved themes and overrides on an upgraded choice", () => {
    const library = [
      { id: "a", name: "A", mode: "light", input: BW_DARK_INPUT },
    ];
    const parsed = parsePersisted(
      JSON.stringify({
        v: 2,
        active: { kind: "preset", presetId: "default-dark" },
        library,
        ui: { border: "#111111" },
      })
    );
    expect(parsed?.library).toEqual(library);
    expect(parsed?.ui).toEqual({ border: "#111111" });
  });

  it("leaves presets that still exist alone", () => {
    expect(
      parsePersisted('{"v":2,"active":{"kind":"preset","presetId":"rain"}}')
        ?.active
    ).toEqual({ kind: "preset", presetId: "rain" });
  });
});
