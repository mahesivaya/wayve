// Dark is the default for every visitor; the OS preference is deliberately
// ignored. A pre-paint script in index.html sets data-theme before React mounts
// to avoid a flash, and this hook keeps that attribute in sync as the user
// toggles.

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
      // Only an explicit light override is persisted; dark stores no key.
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

  // `resolved` exists for the toggle button, which reads it to pick the sun or
  // moon icon. It equals `choice` because the OS preference is ignored.
  return { choice, resolved: choice, setTheme, toggle };
}
