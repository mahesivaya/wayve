// The platform-wide UI font catalog — the single source of truth for the font
// dropdown (settings) AND the runtime application at boot. The backend stores
// only a short `font_key` (validated against this same allowlist); the mapping
// to an actual CSS stack lives here.
//
// A choice overrides the `--sans` and `--heading` tokens (defined in index.css)
// for the whole app. `--mono` is deliberately left alone so code, API keys and
// token readouts stay monospaced. Every option renders with no extra font
// assets: Inter + IBM Plex Sans are already loaded by the <link> in index.html;
// the rest are system stacks.

export type FontKey = "system" | "inter" | "ibm-plex" | "serif" | "mono";

export type FontOption = {
  key: FontKey;
  label: string;
  // The CSS font-family stack applied to `--sans` and `--heading`.
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

// Normalize an arbitrary/unknown/null value to a known key (unknown → default).
export function normalizeFontKey(key: string | null | undefined): FontKey {
  const match = FONT_OPTIONS.find((o) => o.key === key);
  return match ? match.key : DEFAULT_FONT_KEY;
}

// Apply (or clear) the platform font on the document root. Called at boot with
// the server value and optimistically from the settings page on change.
//
// `system`/null/unknown → remove the overrides so the app falls back to the
// index.css defaults (index.css stays the single default source). Any other key
// → set `--sans` and `--heading` to its stack. `--mono` is never touched.
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
