// Kept separate from CustomThemeContext.tsx so that provider file exports only
// React components, which the react-refresh ESLint rule requires for HMR.

import { createContext } from "react";

import type { PaletteInput } from "./palette";
import type { TokenOverrides, TokenRole } from "./customTokens";

export type ThemeMode = "light" | "dark";

export type ThemeChoice =
  | { kind: "preset"; presetId: string }
  | { kind: "custom"; mode: ThemeMode; input: PaletteInput }
  // Holds only the id, resolving input/mode from `library`, so renames and edits
  // stay live.
  | { kind: "saved"; id: string }
  | { kind: "default" };

export interface SavedTheme {
  id: string;
  name: string;
  mode: ThemeMode;
  input: PaletteInput;
}

// Per-role overrides from the UI tab, layered on top of the generated palette.
export type UiOverrides = Partial<Record<TokenRole, string>>;

// Deliberately small: exposing every token for direct editing can make the app
// unreadable, so only high-impact, contrast-guarded roles are editable.
export const UI_OVERRIDE_ROLES: { role: TokenRole; label: string }[] = [
  { role: "primary-action", label: "Accent" },
  { role: "surface", label: "Surface" },
  { role: "text-primary", label: "Text" },
  { role: "border", label: "Border" },
  { role: "success", label: "Success" },
  { role: "danger", label: "Danger" },
];

// Defined here rather than in themeStorage so the context value can reference it
// without an import cycle.
export interface PersistedTheme {
  active: ThemeChoice;
  library: SavedTheme[];
  ui: UiOverrides;
}

export interface CustomThemeValue {
  choice: ThemeChoice;
  setChoice: (next: ThemeChoice) => void;
  resetToDefault: () => void;
  previewInput: (input: PaletteInput, mode: ThemeMode) => void;
  clearPreview: () => void;

  library: SavedTheme[];
  saveTheme: (name: string, mode: ThemeMode, input: PaletteInput) => string;
  renameTheme: (id: string, name: string) => void;
  deleteTheme: (id: string) => void;

  ui: UiOverrides;
  setUiOverride: (role: TokenRole, color: string) => void;
  clearUiOverride: (role: TokenRole) => void;
  resetUi: () => void;

  // Tokens for the active choice before UI overrides, used to seed the UI tab's
  // color inputs with the current effective color.
  baseTokens: TokenOverrides;

  // Replaces the entire state at once; used by the backend hydration bridge.
  hydrate: (state: PersistedTheme) => void;
}

export const CustomThemeContext = createContext<CustomThemeValue | null>(null);
