// Dark-mode hook. Two states only:
//   "dark"  — the navy default for every visitor (OS preference ignored)
//   "light" — user has explicitly chosen light and we set
//             data-theme="light" on <html>
//
// The pre-paint script in index.html sets data-theme="dark" or "light"
// before React mounts to avoid any flash. This hook keeps the attribute
// in sync as the user toggles and writes the choice to localStorage.

import { useCallback, useState } from "react";

export type ThemeChoice = "light" | "dark";

const STORAGE_KEY = "wayve-theme";

function readChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light") return "light";
  } catch {
    // ignore — storage may be blocked
  }
  return "dark";
}

function applyChoice(choice: ThemeChoice) {
  document.documentElement.setAttribute("data-theme", choice);
}

export function useTheme() {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readChoice());

  const setTheme = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      // Dark is the default (no key stored); only persist an explicit
      // light override.
      if (next === "dark") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore — storage blocked
    }
    applyChoice(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(choice === "dark" ? "light" : "dark");
  }, [choice, setTheme]);

  // `resolved` is kept for backward compatibility with the toggle button,
  // which reads `resolved` to decide which icon (sun/moon) to render.
  // With OS preference ignored, resolved === choice.
  return { choice, resolved: choice, setTheme, toggle };
}
