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
    input: {
      hue: 205,
      chroma: 0.18,
      saturation: 1.1,
      contrast: 0.7,
      depth: -0.02,
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Deep dark with violet accent.",
    mode: "dark",
    input: {
      hue: 270,
      chroma: 0.17,
      saturation: 1.1,
      contrast: 0.7,
      depth: 0.02,
    },
  },
  {
    id: "forest",
    name: "Forest",
    description: "Calm green, easy on the eyes.",
    mode: "dark",
    input: {
      hue: 155,
      chroma: 0.14,
      saturation: 1,
      contrast: 0.6,
      depth: 0.01,
    },
  },
  {
    id: "plum",
    name: "Plum",
    description: "Rich magenta on near-black.",
    mode: "dark",
    input: {
      hue: 300,
      chroma: 0.16,
      saturation: 1.1,
      contrast: 0.65,
      depth: 0.02,
    },
  },
  {
    id: "rose",
    name: "Rose",
    description: "Warm pink, soft light surfaces.",
    mode: "light",
    input: { hue: 350, chroma: 0.13, saturation: 1, contrast: 0.55, depth: 0 },
  },
  {
    id: "cream",
    name: "Cream",
    description: "Warm paper tones, amber accent.",
    mode: "light",
    input: {
      hue: 75,
      chroma: 0.12,
      saturation: 0.95,
      contrast: 0.5,
      depth: 0.01,
    },
  },
  {
    id: "slate",
    name: "Slate",
    description: "Muted neutral grey-blue.",
    mode: "dark",
    input: { hue: 220, chroma: 0.05, saturation: 0.8, contrast: 0.6, depth: 0 },
  },
];

export function tokensForPreset(preset: ThemePreset): TokenOverrides {
  return generatePalette(preset.input, preset.mode);
}

export function findPreset(id: string): ThemePreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
