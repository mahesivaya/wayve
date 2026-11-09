// The app's text size, from Settings › Appearance, as a percentage. Stored per
// browser and applied at boot so a returning user paints at their size. It
// scales the --text-* font tokens and rem units rather than zooming the page,
// which would throw off drag-to-resize and full-height layouts.

export const TEXT_SIZES = [90, 100, 110, 125, 150] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const DEFAULT_TEXT_SIZE: TextSize = 100;

const TEXT_SIZE_KEY = "wayve-text-size";

export function getTextSize(): TextSize {
  try {
    const stored = Number(localStorage.getItem(TEXT_SIZE_KEY));
    return TEXT_SIZES.find((size) => size === stored) ?? DEFAULT_TEXT_SIZE;
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

export function saveTextSize(size: TextSize): void {
  try {
    localStorage.setItem(TEXT_SIZE_KEY, String(size));
  } catch {
    /* per-browser convenience only */
  }
}

export function applyTextSize(size: TextSize): void {
  const root = document.documentElement;
  if (size === DEFAULT_TEXT_SIZE) {
    root.style.removeProperty("--text-scale");
    root.style.removeProperty("font-size");
    return;
  }
  root.style.setProperty("--text-scale", String(size / 100));
  root.style.setProperty("font-size", `${size}%`);
}
