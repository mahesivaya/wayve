// Runtime theme store. Holds the user's choice (preset id OR custom inputs +
// mode) and applies it to :root as CSS variable overrides. Persistence is
// localStorage-only here; the optional backend sync layer wraps this.
//
// The applied tokens are the union of:
//   1. the selected preset's palette (if any), OR
//   2. the generated palette from the custom inputs (if any)
// Either way, the result is the same shape: a map of role → CSS color string.
//
// Apply order matters: writing each token as
// `document.documentElement.style.setProperty("--color-foo", "...")` takes
// precedence over the stylesheet rules in src/index.css. To revert to the
// stylesheet default, we call `removeProperty` for that role.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { ALL_ROLES, TOKEN_VAR, type TokenOverrides } from "./customTokens";
import {
  CustomThemeContext,
  type CustomThemeValue,
  type ThemeChoice,
  type ThemeMode,
} from "./customThemeShared";
import { generatePalette, type PaletteInput } from "./palette";
import { findPreset, tokensForPreset } from "./themePresets";

const STORAGE_KEY = "wayve-custom-theme-v1";

interface PersistedShape {
  choice: ThemeChoice;
}

function loadFromStorage(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { kind: "default" };
    const parsed = JSON.parse(raw) as PersistedShape;
    if (parsed.choice) return parsed.choice;
  } catch {
    // ignore — storage may be blocked or value corrupted
  }
  return { kind: "default" };
}

function saveToStorage(choice: ThemeChoice) {
  try {
    if (choice.kind === "default") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ choice }));
    }
  } catch {
    // ignore — storage blocked
  }
}

function tokensForChoice(choice: ThemeChoice): TokenOverrides {
  if (choice.kind === "default") return {};
  if (choice.kind === "preset") {
    const p = findPreset(choice.presetId);
    return p ? tokensForPreset(p) : {};
  }
  return generatePalette(choice.input, choice.mode);
}

function applyTokensToRoot(tokens: TokenOverrides) {
  const root = document.documentElement;
  for (const role of ALL_ROLES) {
    const value = tokens[role];
    const cssVar = TOKEN_VAR[role];
    if (value !== undefined) {
      root.style.setProperty(cssVar, value);
    } else {
      root.style.removeProperty(cssVar);
    }
  }
}

// Sets data-theme on <html> to match the choice's effective mode. This keeps
// the existing light/dark stylesheet rules (those that target
// `:root[data-theme="dark"]` in index.css) in step with the override layer.
function applyMode(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice.kind === "default") {
    // Keep whatever mode the existing useTheme hook set.
    return;
  }
  const mode = choice.kind === "preset"
    ? findPreset(choice.presetId)?.mode ?? "light"
    : choice.mode;
  root.setAttribute("data-theme", mode);
}

export function CustomThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => loadFromStorage());

  useEffect(() => {
    applyTokensToRoot(tokensForChoice(choice));
    applyMode(choice);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    saveToStorage(next);
  }, []);

  const resetToDefault = useCallback(() => {
    setChoice({ kind: "default" });
  }, [setChoice]);

  const previewInput = useCallback((input: PaletteInput, mode: ThemeMode) => {
    applyTokensToRoot(generatePalette(input, mode));
    document.documentElement.setAttribute("data-theme", mode);
  }, []);

  const clearPreview = useCallback(() => {
    applyTokensToRoot(tokensForChoice(choice));
    applyMode(choice);
  }, [choice]);

  const value = useMemo<CustomThemeValue>(
    () => ({ choice, setChoice, resetToDefault, previewInput, clearPreview }),
    [choice, setChoice, resetToDefault, previewInput, clearPreview],
  );

  return (
    <CustomThemeContext.Provider value={value}>
      {children}
    </CustomThemeContext.Provider>
  );
}
