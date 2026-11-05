import { useSyncExternalStore } from "react";

// How code looks everywhere it's shown (file previews and diffs), chosen on the
// General settings page and remembered per browser. It reaches the code as CSS
// variables on the root, read in githubRepo.css.

export type CodeTokenColors = {
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  type: string;
  tag: string;
};

export type CodeTheme = {
  label: string;
  bg: string;
  fg: string;
  gutter: string;
  tokens: CodeTokenColors;
};

// Comment and gutter colours are lifted from the originals where those fall
// below a readable contrast, which a test holds them to.
export const CODE_THEMES: Record<string, CodeTheme> = {
  "dark-plus": {
    label: "Dark+",
    bg: "#1e1e1e",
    fg: "#d4d4d4",
    gutter: "#858585",
    tokens: {
      comment: "#7ca668",
      keyword: "#c586c0",
      string: "#ce9178",
      number: "#b5cea8",
      function: "#dcdcaa",
      type: "#4ec9b0",
      tag: "#9cdcfe",
    },
  },
  "one-dark": {
    label: "One Dark",
    bg: "#282c34",
    fg: "#abb2bf",
    gutter: "#7f848e",
    tokens: {
      comment: "#969dab",
      keyword: "#c678dd",
      string: "#98c379",
      number: "#d19a66",
      function: "#61afef",
      type: "#e5c07b",
      tag: "#e4757e",
    },
  },
  dracula: {
    label: "Dracula",
    bg: "#282a36",
    fg: "#f8f8f2",
    gutter: "#8a90ad",
    tokens: {
      comment: "#98a4cc",
      keyword: "#ff79c6",
      string: "#f1fa8c",
      number: "#bd93f9",
      function: "#50fa7b",
      type: "#8be9fd",
      tag: "#ff79c6",
    },
  },
  nord: {
    label: "Nord",
    bg: "#2e3440",
    fg: "#d8dee9",
    gutter: "#8f9bb3",
    tokens: {
      comment: "#9aa8c0",
      keyword: "#8fb0d1",
      string: "#a3be8c",
      number: "#c09cb9",
      function: "#88c0d0",
      type: "#8fbcbb",
      tag: "#8fb0d1",
    },
  },
  monokai: {
    label: "Monokai",
    bg: "#272822",
    fg: "#f8f8f2",
    gutter: "#90908a",
    tokens: {
      comment: "#a8a48c",
      keyword: "#ff5c93",
      string: "#e6db74",
      number: "#ae81ff",
      function: "#a6e22e",
      type: "#66d9ef",
      tag: "#ff5c93",
    },
  },
  "github-dark": {
    label: "GitHub Dark",
    bg: "#0d1117",
    fg: "#e6edf3",
    gutter: "#848d97",
    tokens: {
      comment: "#8b949e",
      keyword: "#ff7b72",
      string: "#a5d6ff",
      number: "#79c0ff",
      function: "#d2a8ff",
      type: "#ffa657",
      tag: "#7ee787",
    },
  },
  "github-light": {
    label: "GitHub Light",
    bg: "#ffffff",
    fg: "#1f2328",
    gutter: "#6e7781",
    tokens: {
      comment: "#59636e",
      keyword: "#cf222e",
      string: "#0a3069",
      number: "#0550ae",
      function: "#6639ba",
      type: "#953800",
      tag: "#116329",
    },
  },
  "solarized-light": {
    label: "Solarized Light",
    bg: "#fdf6e3",
    fg: "#44565c",
    gutter: "#66767b",
    tokens: {
      comment: "#5f6f74",
      keyword: "#5a6800",
      string: "#17716a",
      number: "#b02c36",
      function: "#1c68a8",
      type: "#94530a",
      tag: "#5a5fb5",
    },
  },
};

// Installed fonts only: a machine without the chosen one falls back to the
// default monospace font.
export const CODE_FONTS: Record<string, { label: string; family: string }> = {
  "sf-mono": { label: "SF Mono", family: '"SF Mono", SFMono-Regular' },
  menlo: { label: "Menlo", family: "Menlo" },
  monaco: { label: "Monaco", family: "Monaco" },
  consolas: { label: "Consolas", family: "Consolas" },
  cascadia: { label: "Cascadia Code", family: '"Cascadia Code"' },
  jetbrains: { label: "JetBrains Mono", family: '"JetBrains Mono"' },
  fira: { label: "Fira Code", family: '"Fira Code"' },
  source: { label: "Source Code Pro", family: '"Source Code Pro"' },
  courier: { label: "Courier New", family: '"Courier New"' },
};

export const CODE_FONT_SIZES = [11, 12, 13, 14, 15, 16, 18];
export const CODE_TAB_SIZES = [2, 4, 8];

export const CODE_LINE_HEIGHTS = {
  compact: { label: "Compact", value: 1.3 },
  regular: { label: "Regular", value: 1.5 },
  relaxed: { label: "Relaxed", value: 1.75 },
};

export const CODE_FONT_WEIGHTS = {
  light: { label: "Light", value: 300 },
  regular: { label: "Regular", value: 400 },
  medium: { label: "Medium", value: 500 },
};

export type CodeSettings = {
  // "auto" follows the interface theme.
  theme: string;
  // "default" is the app's monospace font.
  font: string;
  // Takes priority over `font` when set.
  customFont: string;
  fontSize: number;
  lineHeight: keyof typeof CODE_LINE_HEIGHTS;
  fontWeight: keyof typeof CODE_FONT_WEIGHTS;
  italicComments: boolean;
  ligatures: boolean;
  tabSize: number;
  wrapLines: boolean;
  lineNumbers: boolean;
};

export const DEFAULT_CODE_SETTINGS: CodeSettings = {
  theme: "auto",
  font: "default",
  customFont: "",
  fontSize: 13,
  lineHeight: "regular",
  fontWeight: "regular",
  italicComments: true,
  ligatures: false,
  tabSize: 2,
  wrapLines: false,
  lineNumbers: true,
};

const STORAGE_KEY = "rwayve.code.settings.v1";

// Storage can hold anything, so a value that's no longer an option falls back
// rather than reaching the page.
function sanitize(raw: Partial<CodeSettings>): CodeSettings {
  const d = DEFAULT_CODE_SETTINGS;
  const bool = (value: unknown, fallback: boolean) =>
    typeof value === "boolean" ? value : fallback;
  return {
    theme: raw.theme && raw.theme in CODE_THEMES ? raw.theme : d.theme,
    font: raw.font && raw.font in CODE_FONTS ? raw.font : d.font,
    customFont: typeof raw.customFont === "string" ? raw.customFont : "",
    fontSize: CODE_FONT_SIZES.includes(raw.fontSize ?? 0)
      ? (raw.fontSize as number)
      : d.fontSize,
    lineHeight:
      raw.lineHeight && raw.lineHeight in CODE_LINE_HEIGHTS
        ? raw.lineHeight
        : d.lineHeight,
    fontWeight:
      raw.fontWeight && raw.fontWeight in CODE_FONT_WEIGHTS
        ? raw.fontWeight
        : d.fontWeight,
    italicComments: bool(raw.italicComments, d.italicComments),
    ligatures: bool(raw.ligatures, d.ligatures),
    tabSize: CODE_TAB_SIZES.includes(raw.tabSize ?? 0)
      ? (raw.tabSize as number)
      : d.tabSize,
    wrapLines: bool(raw.wrapLines, d.wrapLines),
    lineNumbers: bool(raw.lineNumbers, d.lineNumbers),
  };
}

function read(): CodeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitize(JSON.parse(raw));
  } catch {
    // Unreadable storage: fall back to the defaults.
  }
  return DEFAULT_CODE_SETTINGS;
}

function fontFamily(settings: CodeSettings): string {
  // Only what a font's name can hold, so typed text can't write other CSS.
  const custom = settings.customFont.replace(/[^\p{L}\p{N} _-]/gu, "").trim();
  if (custom) return `"${custom}", var(--mono)`;
  const font = CODE_FONTS[settings.font];
  return font ? `${font.family}, var(--mono)` : "var(--mono)";
}

function apply(settings: CodeSettings) {
  const root = document.documentElement.style;
  const vars: Record<string, string> = {
    "--syntax-font-family": fontFamily(settings),
    "--syntax-font-size": `${settings.fontSize}px`,
    "--syntax-line-height": String(
      CODE_LINE_HEIGHTS[settings.lineHeight].value
    ),
    "--syntax-font-weight": String(
      CODE_FONT_WEIGHTS[settings.fontWeight].value
    ),
    "--syntax-comment-style": settings.italicComments ? "italic" : "normal",
    "--syntax-ligatures": settings.ligatures ? "normal" : "none",
    "--syntax-tab-size": String(settings.tabSize),
  };
  for (const [name, value] of Object.entries(vars)) {
    root.setProperty(name, value);
  }

  // No theme means no overrides, leaving the interface's colours.
  const theme = CODE_THEMES[settings.theme] as CodeTheme | undefined;
  const themeVars: Record<string, string> = {
    bg: theme?.bg ?? "",
    fg: theme?.fg ?? "",
    gutter: theme?.gutter ?? "",
    border: theme ? `color-mix(in srgb, ${theme.gutter} 35%, transparent)` : "",
    "add-bg": theme ? "color-mix(in srgb, #2ea043 22%, transparent)" : "",
    "del-bg": theme ? "color-mix(in srgb, #f85149 22%, transparent)" : "",
    ...theme?.tokens,
  };
  for (const name of [
    "bg",
    "fg",
    "gutter",
    "border",
    "add-bg",
    "del-bg",
    "comment",
    "keyword",
    "string",
    "number",
    "function",
    "type",
    "tag",
  ]) {
    if (theme) root.setProperty(`--syntax-${name}`, themeVars[name]);
    else root.removeProperty(`--syntax-${name}`);
  }
}

let current = read();
apply(current);

const listeners = new Set<() => void>();

function publish(next: CodeSettings) {
  current = next;
  apply(next);
  listeners.forEach((listener) => listener());
}

// Another tab changing the settings updates this one too.
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) publish(read());
});

export function saveCodeSettings(next: CodeSettings) {
  publish(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not persisted; the choice still holds for this visit.
  }
}

export function useCodeSettings(): CodeSettings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current
  );
}
