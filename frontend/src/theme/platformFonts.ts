// The UI font catalog: the allowlist the backend validates its stored `font_key`
// against, and the key→CSS-stack mapping. A choice overrides `--sans` and
// `--heading`; `--mono` is deliberately left alone so code, API keys and token
// readouts stay monospaced. No option needs extra font assets — Inter and IBM
// Plex Sans are already loaded in index.html and the rest are system stacks.

export type FontKey = "system" | "inter" | "ibm-plex" | "serif" | "mono";

export type FontOption = {
  key: FontKey;
  label: string;
  stack: string;
};

export const FONT_OPTIONS: FontOption[] = [
  {
    key: "system",
    label: "System (default)",
    stack: 'system-ui, "Segoe UI", Roboto, sans-serif',
  },
  { key: "inter", label: "Inter", stack: '"Inter", system-ui, sans-serif' },
  {
    key: "ibm-plex",
    label: "IBM Plex Sans",
    stack: '"IBM Plex Sans", system-ui, sans-serif',
  },
  { key: "serif", label: "Serif", stack: 'Georgia, "Times New Roman", serif' },
  {
    key: "mono",
    label: "Monospace",
    stack: 'ui-monospace, "Cascadia Code", Consolas, monospace',
  },
];

export const DEFAULT_FONT_KEY: FontKey = "system";

export function normalizeFontKey(key: string | null | undefined): FontKey {
  const match = FONT_OPTIONS.find((o) => o.key === key);
  return match ? match.key : DEFAULT_FONT_KEY;
}

// Caches the resolved font so a returning user paints in it at boot, before
// /api/ui/font resolves, with no flash. Empty string means an explicit "no
// override"; null means unknown, so fall back to the platform default.
export const FONT_CACHE_KEY = "wayve-font";

export function cachedFontKey(): string | null {
  try {
    return localStorage.getItem(FONT_CACHE_KEY);
  } catch {
    return null;
  }
}

export function cacheFontKey(key: string | null): void {
  try {
    localStorage.setItem(FONT_CACHE_KEY, key ?? "");
  } catch {
    /* ignore */
  }
}

export function clearFontCache(): void {
  try {
    localStorage.removeItem(FONT_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

// The default key removes the overrides rather than writing a stack, so
// index.css remains the single source of the default font.
export function applyPlatformFont(key: string | null | undefined): void {
  const root = document.documentElement;
  const resolved = normalizeFontKey(key);
  if (resolved === DEFAULT_FONT_KEY) {
    root.style.removeProperty("--sans");
    root.style.removeProperty("--heading");
    return;
  }
  const stack = FONT_OPTIONS.find((o) => o.key === resolved)!.stack;
  root.style.setProperty("--sans", stack);
  root.style.setProperty("--heading", stack);
}
