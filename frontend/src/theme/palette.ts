// Derives the full customizable token set from five inputs and a target mode.
// Colors are emitted as OKLCH, which every current browser supports natively:
// its perceptual uniformity means a given lightness step looks the same at
// every hue, so generated palettes stay readable across the whole spectrum.

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
  // Browsers clamp out-of-gamut OKLCH to the nearest displayable color, but
  // staying in range keeps the result predictable.
  const L = Math.max(0, Math.min(1, l));
  const C = Math.max(0, Math.min(0.4, c));
  const H = ((h % 360) + 360) % 360;
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`;
}

// Status hues are fixed, never user-retinted: a green "danger" would be unusable.
const HUE_SUCCESS = 145;
const HUE_DANGER = 25;
const HUE_WARNING = 75;

export function generatePalette(
  input: PaletteInput,
  mode: "light" | "dark"
): TokenOverrides {
  const { hue, chroma, saturation, contrast, depth } = input;

  // Light mode uses high-lightness surfaces with low-lightness text; dark mode
  // inverts that. Depth shifts surface darkness; contrast pulls text further
  // from the surface.
  const isDark = mode === "dark";

  // Tint scales with chroma so a neutral theme keeps clean white / near-black
  // surfaces. In light mode the surface lightness must drop as the tint grows:
  // a near-white surface physically cannot hold much chroma, so without the drop
  // a strong color just clamps back to pale.
  const tint = chroma * saturation; // 0 (neutral) .. ~0.45 (vivid)
  const surfaceChroma = Math.min(tint * 0.7, 0.16);
  const tintDrop = isDark ? 0 : tint * 0.3;

  const surfaceL = isDark ? 0.18 - depth : 0.99 + depth - tintDrop;
  const surfaceSoftL = isDark ? 0.14 - depth : 0.96 + depth - tintDrop;
  const surfaceHoverL = isDark ? 0.24 - depth : 0.94 + depth - tintDrop;
  const textPrimaryL = isDark ? 0.92 + 0.05 * contrast : 0.18 - 0.1 * contrast;
  const textSecondaryL = isDark ? 0.8 + 0.05 * contrast : 0.32 - 0.1 * contrast;
  const textMutedL = isDark ? 0.62 : 0.5;
  const textInkL = isDark ? 0.88 : 0.22;
  const borderL = isDark ? 0.28 : 0.9;
  const borderSoftL = isDark ? 0.24 : 0.93;
  const borderMutedL = isDark ? 0.32 : 0.86;

  // Mid lightness so the primary action color works on light and dark surfaces.
  const primaryL = isDark ? 0.68 : 0.55;
  const primaryHoverL = isDark ? 0.78 : 0.62;
  const primarySoftL = isDark ? 0.22 : 0.94;
  const primaryActionL = isDark ? 0.62 : 0.5;
  const primaryActionHoverL = isDark ? 0.72 : 0.58;

  // Soft variants use a reduced chroma so the page doesn't feel painted.
  const softChroma = chroma * 0.35 * saturation;
  const accentChroma = chroma * 0.85 * saturation;

  return {
    surface: oklch(surfaceL, surfaceChroma, hue),
    "surface-soft": oklch(surfaceSoftL, surfaceChroma, hue),
    "surface-hover": oklch(surfaceHoverL, surfaceChroma, hue),
    // Canvas and pane track the surface tokens rather than taking fixed colors,
    // so a generated theme actually retints the page background.
    canvas: oklch(surfaceSoftL, surfaceChroma, hue),
    pane: oklch(surfaceHoverL, surfaceChroma, hue),
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

// Lets the preset file define themes with literal color strings, bypassing the
// generator.
export function rolesFromMap(
  map: Partial<Record<TokenRole, string>>
): TokenOverrides {
  return { ...map };
}

// The bounds keep chroma and contrast in a readable range, so a random theme is
// never garish or illegible.
export function randomInput(): PaletteInput {
  const rand = (min: number, max: number) => min + Math.random() * (max - min);
  return {
    hue: Math.round(rand(0, 360)),
    chroma: Number(rand(0.06, 0.2).toFixed(3)),
    saturation: Number(rand(0.7, 1.2).toFixed(2)),
    contrast: Number(rand(0.45, 0.7).toFixed(2)),
    depth: Number(rand(-0.02, 0.02).toFixed(3)),
  };
}

// Normalizes any CSS color string to [r,g,b] by round-tripping it through a 2D
// canvas fillStyle. Returns null when there is no canvas (e.g. SSR).
function cssColorToRgb(color: string): [number, number, number] | null {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#000";
    ctx.fillStyle = color;
    const normalized = ctx.fillStyle; // "#rrggbb" or "rgba(r, g, b, a)"
    if (normalized.startsWith("#")) {
      const r = parseInt(normalized.slice(1, 3), 16);
      const g = parseInt(normalized.slice(3, 5), 16);
      const b = parseInt(normalized.slice(5, 7), 16);
      return [r, g, b];
    }
    const m = normalized.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const [r, g, b] = m[1].split(",").map((p) => parseFloat(p));
      return [r, g, b];
    }
  } catch {
    // ignore
  }
  return null;
}

// Seeds <input type=color>, which only accepts #rrggbb.
export function cssColorToHex(color: string, fallback = "#888888"): string {
  const rgb = cssColorToRgb(color);
  if (!rgb) return fallback;
  return (
    "#" +
    rgb
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, "0")
      )
      .join("")
  );
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// WCAG contrast ratio (1..21). Null if either color can't be resolved.
export function contrastRatio(fg: string, bg: string): number | null {
  const a = cssColorToRgb(fg);
  const b = cssColorToRgb(bg);
  if (!a || !b) return null;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
