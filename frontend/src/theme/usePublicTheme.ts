// Light/dark for the public pages only: the landing page, login, register and
// forgot-password. Kept apart from the signed-in app's theme (data-theme on
// <html>, see useTheme / CustomThemeContext) so it never changes a page after
// login: the pages put the mode on their own root as `data-public-theme`.
//
// Dark (a black background) is the default; only an explicit light pick is
// stored. localStorage is the store, so every toggle and page on screen agrees,
// and a same-tab event stands in for `storage`, which only fires in other tabs.

import { useCallback, useSyncExternalStore } from "react";

import type { ThemeMode } from "./customThemeShared";

export const PUBLIC_THEME_STORAGE_KEY = "fluxze-public-theme";
const CHANGE_EVENT = "fluxze-public-theme-change";

function read(): ThemeMode {
  try {
    if (localStorage.getItem(PUBLIC_THEME_STORAGE_KEY) === "light") {
      return "light";
    }
  } catch {
    // ignore — storage may be blocked
  }
  return "dark";
}

function write(mode: ThemeMode) {
  try {
    if (mode === "light")
      localStorage.setItem(PUBLIC_THEME_STORAGE_KEY, "light");
    else localStorage.removeItem(PUBLIC_THEME_STORAGE_KEY);
  } catch {
    // ignore — storage may be blocked; the change still applies via the event
  }
}

let fallback: ThemeMode | null = null;

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

// With storage blocked, `read` can't see a pick, so the in-memory one wins.
function getSnapshot(): ThemeMode {
  return fallback ?? read();
}

function getServerSnapshot(): ThemeMode {
  return "dark";
}

export function usePublicTheme(): {
  mode: ThemeMode;
  toggle: () => void;
} {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback(() => {
    const next: ThemeMode = getSnapshot() === "dark" ? "light" : "dark";
    write(next);
    fallback = read() === next ? null : next;
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { mode, toggle };
}
