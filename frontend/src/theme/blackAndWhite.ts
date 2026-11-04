import type { PaletteInput } from "./palette";

// The monochrome themes: white and near-black. Shared by the theme
// editor's black & white toggle and the Light / Dark choice in Settings, so
// "Dark" means the same black in both places.
//
// `chroma: 0` makes generatePalette emit a fully greyscale palette;
// `saturation: 0` is what lets isBwInput distinguish these from a colored theme
// that happens to have chroma 0.
export const BW_LIGHT_INPUT: PaletteInput = {
  hue: 0,
  chroma: 0,
  saturation: 0,
  contrast: 1,
  // Cards land on pure white with the page a step below, so cards, page and menu
  // stay three visibly different levels. A higher depth clamps the card and page
  // to the same white. Depth only touches surfaces, so text and border contrast
  // are unaffected.
  depth: 0.01,
};

export const BW_DARK_INPUT: PaletteInput = {
  hue: 0,
  chroma: 0,
  saturation: 0,
  contrast: 1,
  // The lowest the depth slider goes. Any darker and the page, cards and menu all
  // land so close to black that they can't be told apart.
  depth: -0.05,
};

// What the two inputs held before the page and cards got separate levels. Stored
// themes still carry these exact values.
export const OLD_BW_LIGHT_DEPTH = 0.04;
export const OLD_BW_DARK_DEPTH = 0.05;

export function isBwInput(input: PaletteInput): boolean {
  return input.chroma === 0 && input.saturation === 0;
}
