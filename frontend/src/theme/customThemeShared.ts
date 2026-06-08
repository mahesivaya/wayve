// Shared context + types for the theme customizer. Kept separate from
// CustomThemeContext.tsx so the provider file can export only React
// components — required by the react-refresh ESLint rule for HMR.

import { createContext } from "react";

import type { PaletteInput } from "./palette";
import type { TokenOverrides, TokenRole } from "./customTokens";

export type ThemeMode = "light" | "dark";

export type ThemeChoice =
  | { kind: "preset"; presetId: string }
  | { kind: "custom"; mode: ThemeMode; input: PaletteInput }
  // A library entry chosen as the active theme. Resolves its input/mode from
  // `library` so renames/edits stay live and the row can be highlighted.
  | { kind: "saved"; id: string }
  | { kind: "default" };

// A user-named custom theme stored in the library.
export interface SavedTheme {
  id: string;
  name: string;
  mode: ThemeMode;
  input: PaletteInput;
}

// Scoped per-role color overrides from the "UI" tab, layered on top of the
// generated palette. A curated subset of roles only (see UI_OVERRIDE_ROLES).
export type UiOverrides = Partial<Record<TokenRole, string>>;

// The curated, safe set of roles the "UI" tab exposes for direct editing.
// Deliberately small: editing every token can make the app unreadable, so we
// surface only the few high-impact, low-risk roles (and contrast-guard them).
export const UI_OVERRIDE_ROLES: { role: TokenRole; label: string }[] = [
  { role: "primary-action", label: "Accent" },
  { role: "surface", label: "Surface" },
  { role: "text-primary", label: "Text" },
  { role: "border", label: "Border" },
  { role: "success", label: "Success" },
  { role: "danger", label: "Danger" },
];

// The full persisted theme state: active selection + named library + scoped
// UI overrides. Defined here (not in themeStorage) so the context value can
// reference it without an import cycle.
export interface PersistedTheme {
  active: ThemeChoice;
  library: SavedTheme[];
  ui: UiOverrides;
}

export interface CustomThemeValue {
  // `choice` is the active selection (name kept for continuity).
  choice: ThemeChoice;
  setChoice: (next: ThemeChoice) => void;
  resetToDefault: () => void;
  previewInput: (input: PaletteInput, mode: ThemeMode) => void;
  clearPreview: () => void;

  // Named theme library.
  library: SavedTheme[];
  saveTheme: (name: string, mode: ThemeMode, input: PaletteInput) => string;
  renameTheme: (id: string, name: string) => void;
  deleteTheme: (id: string) => void;

  // Scoped UI-tab color overrides.
  ui: UiOverrides;
  setUiOverride: (role: TokenRole, color: string) => void;
  clearUiOverride: (role: TokenRole) => void;
  resetUi: () => void;

  // Tokens for the active choice *before* UI overrides — used to seed the UI
  // tab's color inputs with the current effective color.
  baseTokens: TokenOverrides;

  // Replace the entire state at once (used by the backend hydration bridge).
  hydrate: (state: PersistedTheme) => void;
}

export const CustomThemeContext = createContext<CustomThemeValue | null>(null);
