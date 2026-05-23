// Dark-mode hook. Two states only:
//   "light" — the default for every visitor (OS preference ignored)
//   "dark"  — user has explicitly chosen dark and we set
//             data-theme="dark" on <html>
//
// The pre-paint script in index.html sets data-theme="light" or "dark"
// before React mounts to avoid any flash. This hook keeps the attribute
// in sync as the user toggles and writes the choice to localStorage.

import { useCallback, useState } from "react";

export type ThemeChoice = "light" | "dark";

const STORAGE_KEY = "wayve-theme";

function readChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark") return "dark";
  } catch {
    // ignore — storage may be blocked
  }
  return "light";
}

function applyChoice(choice: ThemeChoice) {
  document.documentElement.setAttribute("data-theme", choice);
}

export function useTheme() {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readChoice());

  const setTheme = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      if (next === "light") localStorage.removeItem(STORAGE_KEY);
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
