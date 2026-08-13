// Light — a white background — is the default for every visitor; the OS
// preference is deliberately ignored. A pre-paint script in index.html sets
// data-theme before React mounts to avoid a flash, and this hook keeps that
// attribute in sync as the user toggles.

import { useCallback, useState } from "react";

import { readMode, rememberMode } from "./themeStorage";

export type ThemeChoice = "light" | "dark";

function applyChoice(choice: ThemeChoice) {
  document.documentElement.setAttribute("data-theme", choice);
}

export function useTheme() {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readMode());

  const setTheme = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    // Only an explicit dark override is persisted; light stores no key.
    rememberMode(next);
    applyChoice(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(choice === "dark" ? "light" : "dark");
  }, [choice, setTheme]);

  // `resolved` exists for the toggle button, which reads it to pick the sun or
  // moon icon. It equals `choice` because the OS preference is ignored.
  return { choice, resolved: choice, setTheme, toggle };
}
