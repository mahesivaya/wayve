// Runtime theme store: the active choice, the saved library, and the UI color
// overrides, applied to :root as CSS variables. Persistence here is
// localStorage-only; ThemeSyncBridge wraps this with backend sync.
//
// Applied tokens are the base palette with the UI overrides layered on top, so
// the overrides win. Setting an inline property on :root beats the stylesheet
// rules in src/index.css, so reverting a role to its default means calling
// removeProperty rather than writing a value.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  CustomThemeContext,
  type CustomThemeValue,
  type SavedTheme,
  type ThemeChoice,
  type ThemeMode,
  type UiOverrides,
} from "./customThemeShared";
import {
  ALL_ROLES,
  TOKEN_VAR,
  type TokenOverrides,
  type TokenRole,
} from "./customTokens";
import { generatePalette, type PaletteInput } from "./palette";
import { findPreset, tokensForPreset } from "./themePresets";
import {
  EMPTY_PERSISTED,
  parsePersisted,
  rememberMode,
  serializePersisted,
  type PersistedTheme,
} from "./themeStorage";

const STORAGE_KEY = "wayve-custom-theme-v2";
// The previous (v1) key — read once for migration, then removed.
const LEGACY_STORAGE_KEY = "wayve-custom-theme-v1";

function loadFromStorage(): PersistedTheme {
  try {
    const current = parsePersisted(localStorage.getItem(STORAGE_KEY));
    if (current) return current;
    // Migrate a v1 blob forward, then drop the old key.
    const legacy = parsePersisted(localStorage.getItem(LEGACY_STORAGE_KEY));
    if (legacy) {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return legacy;
    }
  } catch {
    // ignore — storage may be blocked or value corrupted
  }
  return EMPTY_PERSISTED;
}

function saveToStorage(state: PersistedTheme) {
  try {
    const serialized = serializePersisted(state);
    if (serialized === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, serialized);
    }
  } catch {
    // ignore — storage blocked
  }
}

function genId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  // Math.random is fine here: the id is local-only, never a security boundary.
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function baseTokensFor(
  active: ThemeChoice,
  library: SavedTheme[]
): TokenOverrides {
  if (active.kind === "default") return {};
  if (active.kind === "preset") {
    const p = findPreset(active.presetId);
    return p ? tokensForPreset(p) : {};
  }
  if (active.kind === "saved") {
    const saved = library.find((t) => t.id === active.id);
    return saved ? generatePalette(saved.input, saved.mode) : {};
  }
  return generatePalette(active.input, active.mode);
}

// Drives the data-theme attribute. The default choice resolves to light, so
// resetting lands back on the white default rather than keeping whatever mode
// the previously active theme happened to paint.
function modeFor(active: ThemeChoice, library: SavedTheme[]): ThemeMode {
  if (active.kind === "default") return "light";
  if (active.kind === "preset")
    return findPreset(active.presetId)?.mode ?? "light";
  if (active.kind === "saved") {
    return library.find((t) => t.id === active.id)?.mode ?? "light";
  }
  return active.mode;
}

function applyTokensToRoot(tokens: TokenOverrides) {
  const root = document.documentElement;
  for (const role of ALL_ROLES) {
    const value = tokens[role];
    const cssVar = TOKEN_VAR[role];
    if (value !== undefined) {
      root.style.setProperty(cssVar, value);
    } else {
      root.style.removeProperty(cssVar);
    }
  }
}

export function CustomThemeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PersistedTheme>(() => loadFromStorage());
  const { active, library, ui } = state;

  const baseTokens = useMemo(
    () => baseTokensFor(active, library),
    [active, library]
  );

  useEffect(() => {
    applyTokensToRoot({ ...baseTokens, ...ui });
    const mode = modeFor(active, library);
    document.documentElement.setAttribute("data-theme", mode);
    // Mirror it for the pre-paint script, so the next load opens on the right
    // surface instead of flashing the light default first.
    rememberMode(mode);
  }, [baseTokens, ui, active, library]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setState((prev) => {
      const updated = { ...prev, active: next };
      saveToStorage(updated);
      return updated;
    });
  }, []);

  const resetToDefault = useCallback(() => {
    setState((prev) => {
      // Clear the palette and overrides but keep the saved library; wiping a
      // user's saved themes on "reset" would be destructive.
      const updated: PersistedTheme = {
        ...prev,
        active: { kind: "default" },
        ui: {},
      };
      saveToStorage(updated);
      return updated;
    });
  }, []);

  const saveTheme = useCallback(
    (name: string, mode: ThemeMode, input: PaletteInput) => {
      const id = genId();
      setState((prev) => {
        const entry: SavedTheme = {
          id,
          name: name.trim() || "Untitled",
          mode,
          input,
        };
        const updated: PersistedTheme = {
          ...prev,
          library: [...prev.library, entry],
          active: { kind: "saved", id },
        };
        saveToStorage(updated);
        return updated;
      });
      return id;
    },
    []
  );

  const renameTheme = useCallback((id: string, name: string) => {
    setState((prev) => {
      const updated: PersistedTheme = {
        ...prev,
        library: prev.library.map((t) =>
          t.id === id ? { ...t, name: name.trim() || t.name } : t
        ),
      };
      saveToStorage(updated);
      return updated;
    });
  }, []);

  const deleteTheme = useCallback((id: string) => {
    setState((prev) => {
      const library = prev.library.filter((t) => t.id !== id);
      // If the deleted theme was active, fall back to default.
      const active: ThemeChoice =
        prev.active.kind === "saved" && prev.active.id === id
          ? { kind: "default" }
          : prev.active;
      const updated: PersistedTheme = { ...prev, library, active };
      saveToStorage(updated);
      return updated;
    });
  }, []);

  const setUiOverride = useCallback((role: TokenRole, color: string) => {
    setState((prev) => {
      const updated: PersistedTheme = {
        ...prev,
        ui: { ...prev.ui, [role]: color },
      };
      saveToStorage(updated);
      return updated;
    });
  }, []);

  const clearUiOverride = useCallback((role: TokenRole) => {
    setState((prev) => {
      const next: UiOverrides = { ...prev.ui };
      delete next[role];
      const updated: PersistedTheme = { ...prev, ui: next };
      saveToStorage(updated);
      return updated;
    });
  }, []);

  const resetUi = useCallback(() => {
    setState((prev) => {
      const updated: PersistedTheme = { ...prev, ui: {} };
      saveToStorage(updated);
      return updated;
    });
  }, []);

  // Backend hydration on login. Persists locally too, so a later offline reload
  // still gets the server-sourced theme.
  const hydrate = useCallback((next: PersistedTheme) => {
    setState(next);
    saveToStorage(next);
  }, []);

  // Live preview while dragging; deliberately does not persist.
  const previewInput = useCallback(
    (input: PaletteInput, mode: ThemeMode) => {
      // Layer UI overrides on top so the preview matches the saved result.
      applyTokensToRoot({ ...generatePalette(input, mode), ...ui });
      document.documentElement.setAttribute("data-theme", mode);
    },
    [ui]
  );

  const clearPreview = useCallback(() => {
    applyTokensToRoot({ ...baseTokens, ...ui });
    document.documentElement.setAttribute(
      "data-theme",
      modeFor(active, library)
    );
  }, [baseTokens, ui, active, library]);

  const value = useMemo<CustomThemeValue>(
    () => ({
      choice: active,
      setChoice,
      resetToDefault,
      previewInput,
      clearPreview,
      library,
      saveTheme,
      renameTheme,
      deleteTheme,
      ui,
      setUiOverride,
      clearUiOverride,
      resetUi,
      baseTokens,
      hydrate,
    }),
    [
      active,
      setChoice,
      resetToDefault,
      previewInput,
      clearPreview,
      library,
      saveTheme,
      renameTheme,
      deleteTheme,
      ui,
      setUiOverride,
      clearUiOverride,
      resetUi,
      baseTokens,
      hydrate,
    ]
  );

  return (
    <CustomThemeContext.Provider value={value}>
      {children}
    </CustomThemeContext.Provider>
  );
}
