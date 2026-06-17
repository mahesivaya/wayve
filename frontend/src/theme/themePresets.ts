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

// Curated set modelled on macro.com's theme gallery. Each is a PaletteInput +
// mode run through generatePalette(). Order matches the gallery (row-major).
export const PRESETS: ThemePreset[] = [
  {
    id: "void",
    name: "Void",
    description: "Near-black, neutral monochrome.",
    mode: "dark",
    input: {
      hue: 240,
      chroma: 0.02,
      saturation: 0.5,
      contrast: 0.7,
      depth: 0.05,
    },
  },
  {
    id: "sleepless",
    name: "Sleepless",
    description: "Crimson accent on deep black.",
    mode: "dark",
    input: {
      hue: 25,
      chroma: 0.18,
      saturation: 1.1,
      contrast: 0.65,
      depth: 0.05,
    },
  },
  {
    id: "groove",
    name: "Groove",
    description: "Warm orange on near-black.",
    mode: "dark",
    input: {
      hue: 55,
      chroma: 0.16,
      saturation: 1.1,
      contrast: 0.6,
      depth: 0.05,
    },
  },
  {
    id: "fluxze-light",
    name: "Fluxze Light",
    description: "Clean white with an amber accent.",
    mode: "light",
    input: {
      hue: 50,
      chroma: 0.14,
      saturation: 1,
      contrast: 0.55,
      depth: 0.02,
    },
  },
  {
    id: "fluxze-dark",
    name: "Fluxze Dark",
    description: "Signature dark with amber accent.",
    mode: "dark",
    input: { hue: 50, chroma: 0.15, saturation: 1, contrast: 0.6, depth: 0.03 },
  },
  {
    id: "satsuma",
    name: "Satsuma",
    description: "Warm mandarin on soft cream.",
    mode: "light",
    input: { hue: 60, chroma: 0.13, saturation: 1, contrast: 0.5, depth: 0.01 },
  },
  {
    id: "manilla",
    name: "Manilla",
    description: "Mellow yellow on charcoal.",
    mode: "dark",
    input: {
      hue: 95,
      chroma: 0.15,
      saturation: 1.1,
      contrast: 0.6,
      depth: 0.05,
    },
  },
  {
    id: "terminal",
    name: "Terminal",
    description: "Phosphor green on black.",
    mode: "dark",
    input: {
      hue: 150,
      chroma: 0.16,
      saturation: 1.1,
      contrast: 0.65,
      depth: 0.05,
    },
  },
  {
    id: "spirit",
    name: "Spirit",
    description: "Airy blue on white.",
    mode: "light",
    input: {
      hue: 250,
      chroma: 0.14,
      saturation: 1,
      contrast: 0.55,
      depth: 0.02,
    },
  },
  {
    id: "lapis",
    name: "Lapis",
    description: "Deep lapis blue on white.",
    mode: "light",
    input: { hue: 258, chroma: 0.16, saturation: 1.1, contrast: 0.6, depth: 0 },
  },
  {
    id: "moon",
    name: "Moon",
    description: "Soft indigo on midnight.",
    mode: "dark",
    input: {
      hue: 255,
      chroma: 0.13,
      saturation: 1,
      contrast: 0.6,
      depth: 0.04,
    },
  },
  {
    id: "rain",
    name: "Rain",
    description: "Violet accent on dark slate.",
    mode: "dark",
    input: {
      hue: 295,
      chroma: 0.16,
      saturation: 1.1,
      contrast: 0.6,
      depth: 0.05,
    },
  },
];

export function tokensForPreset(preset: ThemePreset): TokenOverrides {
  return generatePalette(preset.input, preset.mode);
}

export function findPreset(id: string): ThemePreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
