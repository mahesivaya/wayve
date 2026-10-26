import type { PaletteInput } from "./palette";

// The monochrome themes: plain white and plain black. Shared by the theme
// editor's black & white toggle and the Light / Dark choice in Settings, so
// "Dark" means the same black in both places.
//
// `chroma: 0` makes generatePalette emit a fully greyscale palette;
// `saturation: 0` is what lets isBwInput distinguish these from the colored
// swatches (saturation 1) — including the chroma-0 "Ink" swatch.
export const BW_LIGHT_INPUT: PaletteInput = {
  hue: 0,
  chroma: 0,
  saturation: 0,
  contrast: 1,
  // Positive depth is required for a clean white: at depth 0 the surfaces land
  // at oklch 96%, which reads as flat gray. Depth only touches surfaces, so
  // text and border contrast are unaffected.
  depth: 0.04,
};

export const BW_DARK_INPUT: PaletteInput = {
  hue: 0,
  chroma: 0,
  saturation: 0,
  contrast: 1,
  depth: 0.05,
};

export function isBwInput(input: PaletteInput): boolean {
  return input.chroma === 0 && input.saturation === 0;
}
