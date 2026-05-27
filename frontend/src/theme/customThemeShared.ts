// Shared context + types for the theme customizer. Kept separate from
// CustomThemeContext.tsx so the provider file can export only React
// components — required by the react-refresh ESLint rule for HMR.

import { createContext } from "react";

import type { PaletteInput } from "./palette";

export type ThemeMode = "light" | "dark";

export type ThemeChoice =
  | { kind: "preset"; presetId: string }
  | { kind: "custom"; mode: ThemeMode; input: PaletteInput }
  | { kind: "default" };

export interface CustomThemeValue {
  choice: ThemeChoice;
  setChoice: (next: ThemeChoice) => void;
  resetToDefault: () => void;
  previewInput: (input: PaletteInput, mode: ThemeMode) => void;
  clearPreview: () => void;
}

export const CustomThemeContext = createContext<CustomThemeValue | null>(null);
