// Curated theme presets. Each preset is defined as a PaletteInput plus a
// target mode — the customizer runs them through generatePalette() to produce
// the actual CSS variable overrides. Defining them via the generator (rather
// than as hand-tuned token maps) keeps presets and "custom" themes consistent:
// the generator is the single source of truth for how inputs become a palette.

import { generatePalette, type PaletteInput } from "./palette";
import type { TokenOverrides } from "./customTokens";

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  mode: "light" | "dark";
  input: PaletteInput;
}

export const PRESETS: ThemePreset[] = [
  {
    id: "default-light",
    name: "Default Light",
    description: "The standard rwayve palette.",
    mode: "light",
    input: { hue: 220, chroma: 0.15, saturation: 1, contrast: 0.5, depth: 0 },
  },
  {
    id: "default-dark",
    name: "Default Dark",
    description: "Standard dark mode.",
    mode: "dark",
    input: { hue: 220, chroma: 0.15, saturation: 1, contrast: 0.5, depth: 0 },
  },
  {
    id: "ocean",
    name: "Ocean",
    description: "Deep blue with high contrast.",
    mode: "light",
    input: { hue: 205, chroma: 0.18, saturation: 1.1, contrast: 0.7, depth: -0.02 },
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Deep dark with violet accent.",
    mode: "dark",
    input: { hue: 270, chroma: 0.17, saturation: 1.1, contrast: 0.7, depth: 0.02 },
  },
];

export function tokensForPreset(preset: ThemePreset): TokenOverrides {
  return generatePalette(preset.input, preset.mode);
}

export function findPreset(id: string): ThemePreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
