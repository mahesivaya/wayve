// Macro-style palette generator. Takes five inputs (hue, chroma, saturation,
// contrast, depth) and a target mode (light | dark), and derives the full
// customizable token set in OKLCH color space. OKLCH gives perceptual
// uniformity — a 0.1 step in L looks like the same brightness step at every
// hue, which means generated palettes stay readable across the spectrum.
//
// All modern Chromium/Firefox/Safari support `oklch()` natively, so we emit
// it directly without conversion.
//
// The five inputs correspond to the macro UI's controls:
//   hue        — base accent hue (0..360°), picked from the color grid
//   chroma     — accent color intensity (0..0.30)
//   saturation — multiplier on chroma for soft variants (0..1.5)
//   contrast   — text-to-background distance (0..1)
//   depth      — background darkness shift (-0.05..+0.05 in light,
//                                            -0.05..+0.05 in dark)

import type { TokenOverrides, TokenRole } from "./customTokens";

export interface PaletteInput {
  hue: number; // 0..360
  chroma: number; // 0..0.30
  saturation: number; // 0..1.5
  contrast: number; // 0..1
  depth: number; // -0.05..+0.05
}

export const DEFAULT_INPUT: PaletteInput = {
  hue: 240,
  chroma: 0.16,
  saturation: 1,
  contrast: 0.5,
  depth: 0,
};

function oklch(l: number, c: number, h: number): string {
  // Clamp to safe ranges. Out-of-gamut OKLCH is rendered as the nearest
  // displayable color by the browser, but it's better to keep us inside.
  const L = Math.max(0, Math.min(1, l));
  const C = Math.max(0, Math.min(0.4, c));
  const H = ((h % 360) + 360) % 360;
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`;
}

// Fixed hue anchors for the status colors — green for success, red for
// danger, amber for warning. We don't let the user retint these, since
// "danger" looking green would be a usability disaster.
const HUE_SUCCESS = 145;
const HUE_DANGER = 25;
const HUE_WARNING = 75;

export function generatePalette(
  input: PaletteInput,
  mode: "light" | "dark",
): TokenOverrides {
  const { hue, chroma, saturation, contrast, depth } = input;

  // Lightness anchors. Light mode: high-L surfaces, low-L text.
  // Dark mode: low-L surfaces, high-L text. Depth shifts the surface
  // darkness up or down; contrast pulls the text further from the surface.
  const isDark = mode === "dark";
  const surfaceL = isDark ? 0.18 - depth : 0.99 + depth;
  const surfaceSoftL = isDark ? 0.14 - depth : 0.96 + depth;
  const surfaceHoverL = isDark ? 0.24 - depth : 0.94 + depth;
  const textPrimaryL = isDark ? 0.92 + 0.05 * contrast : 0.18 - 0.10 * contrast;
  const textSecondaryL = isDark ? 0.80 + 0.05 * contrast : 0.32 - 0.10 * contrast;
  const textMutedL = isDark ? 0.62 : 0.50;
  const textInkL = isDark ? 0.88 : 0.22;
  const borderL = isDark ? 0.28 : 0.90;
  const borderSoftL = isDark ? 0.24 : 0.93;
  const borderMutedL = isDark ? 0.32 : 0.86;

  // Primary action color. We render it at a mid lightness so it works
  // against both light and dark surfaces.
  const primaryL = isDark ? 0.68 : 0.55;
  const primaryHoverL = isDark ? 0.78 : 0.62;
  const primarySoftL = isDark ? 0.22 : 0.94;
  const primaryActionL = isDark ? 0.62 : 0.50;
  const primaryActionHoverL = isDark ? 0.72 : 0.58;

  // Soft variants use a reduced chroma so the page doesn't feel painted.
  const softChroma = chroma * 0.35 * saturation;
  const accentChroma = chroma * 0.85 * saturation;

  return {
    surface: oklch(surfaceL, 0, hue),
    "surface-soft": oklch(surfaceSoftL, 0, hue),
    "surface-hover": oklch(surfaceHoverL, 0, hue),
    "text-primary": oklch(textPrimaryL, 0, hue),
    "text-secondary": oklch(textSecondaryL, 0, hue),
    "text-muted": oklch(textMutedL, 0, hue),
    "text-ink": oklch(textInkL, 0, hue),
    border: oklch(borderL, 0, hue),
    "border-soft": oklch(borderSoftL, 0, hue),
    "border-muted": oklch(borderMutedL, 0, hue),
    primary: oklch(primaryL, chroma, hue),
    "primary-hover": oklch(primaryHoverL, chroma, hue),
    "primary-action": oklch(primaryActionL, chroma, hue),
    "primary-action-hover": oklch(primaryActionHoverL, chroma, hue),
    "primary-soft": oklch(primarySoftL, softChroma, hue),
    "accent-indigo": oklch(primaryL, accentChroma, hue + 10),
    "accent-purple": oklch(primaryL, accentChroma, hue + 40),
    success: oklch(isDark ? 0.72 : 0.55, accentChroma, HUE_SUCCESS),
    "success-soft": oklch(isDark ? 0.22 : 0.94, softChroma, HUE_SUCCESS),
    danger: oklch(isDark ? 0.68 : 0.55, accentChroma, HUE_DANGER),
    "danger-soft": oklch(isDark ? 0.24 : 0.94, softChroma, HUE_DANGER),
    warning: oklch(isDark ? 0.78 : 0.65, accentChroma, HUE_WARNING),
    "warning-soft": oklch(isDark ? 0.26 : 0.94, softChroma, HUE_WARNING),
  };
}

// For preset definitions — convert hex (or any CSS color string) to an
// override map keyed by role. The preset file uses friendly hex/oklch strings
// directly without going through the generator.
export function rolesFromMap(map: Partial<Record<TokenRole, string>>): TokenOverrides {
  return { ...map };
}
