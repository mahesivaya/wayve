// Dark-mode hook. Three states:
//   "light" — user chose light (data-theme="light" wins over OS dark)
//   "dark"  — user chose dark
//   "system" — no choice; CSS media query follows OS preference
//
// The pre-paint script in index.html mirrors the saved choice onto
// <html data-theme="…"> before React mounts to avoid a light→dark flash.
// This hook keeps that attribute in sync as the user toggles and writes
// the choice to localStorage.

import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";
export type ThemeResolved = "light" | "dark";

const STORAGE_KEY = "wayve-theme";

function readChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // ignore — storage may be blocked
  }
  return "system";
}

function osPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyChoice(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readChoice());

  // Track whatever is currently rendered so the toggle button can show
  // the right icon (sun vs moon) regardless of whether the source was a
  // user choice or the OS default.
  const [resolved, setResolved] = useState<ThemeResolved>(() =>
    readChoice() === "system" ? (osPrefersDark() ? "dark" : "light") : (readChoice() as ThemeResolved)
  );

  // Listen for OS preference flips. Only matters while choice is "system"
  // — once the user has picked, their pick wins.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      if (readChoice() === "system") {
        setResolved(e.matches ? "dark" : "light");
      }
    };
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);

  const setTheme = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore — storage blocked
    }
    applyChoice(next);
    setResolved(next === "system" ? (osPrefersDark() ? "dark" : "light") : next);
  }, []);

  const toggle = useCallback(() => {
    // Two-state toggle (dark ↔ light) is what the header icon does. The
    // tri-state "system" option lives on a Settings page if/when added.
    setTheme(resolved === "dark" ? "light" : "dark");
  }, [resolved, setTheme]);

  return { choice, resolved, setTheme, toggle };
}
