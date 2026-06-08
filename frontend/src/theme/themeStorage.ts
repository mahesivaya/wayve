// Persisted theme state shape + (de)serialization, shared by the localStorage
// store (CustomThemeContext) and the backend sync bridge (ThemeSyncBridge) so
// both agree on the format and the v1→v2 migration.
//
// v1 stored a single bare `ThemeChoice`. v2 wraps it as
// `{ v: 2, active, library, ui }` to support a named theme library and the
// scoped UI-tab overrides. Reading an old v1 blob migrates it forward.

import type {
  PersistedTheme,
  SavedTheme,
  ThemeChoice,
  UiOverrides,
} from "./customThemeShared";

export type { PersistedTheme };

export const EMPTY_PERSISTED: PersistedTheme = {
  active: { kind: "default" },
  library: [],
  ui: {},
};

function isThemeChoice(value: unknown): value is ThemeChoice {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "default" ||
    kind === "preset" ||
    kind === "custom" ||
    kind === "saved"
  );
}

// Parse a stored blob (from localStorage or the backend `theme_json`) into the
// v2 shape, migrating v1 (a bare ThemeChoice) and tolerating garbage.
export function parsePersisted(
  json: string | null | undefined,
): PersistedTheme | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;

    // v2 — { v: 2, active, library, ui }
    if (obj.v === 2 && isThemeChoice(obj.active)) {
      return {
        active: obj.active,
        library: Array.isArray(obj.library)
          ? (obj.library.filter(
              (t) =>
                t &&
                typeof t === "object" &&
                typeof (t as SavedTheme).id === "string",
            ) as SavedTheme[])
          : [],
        ui:
          obj.ui && typeof obj.ui === "object"
            ? (obj.ui as UiOverrides)
            : {},
      };
    }

    // Legacy v1a — { choice: ThemeChoice } (the old localStorage wrapper).
    if (isThemeChoice(obj.choice)) {
      return { active: obj.choice, library: [], ui: {} };
    }

    // Legacy v1b — a bare ThemeChoice (the old backend wire format).
    if (isThemeChoice(obj)) {
      return { active: obj as unknown as ThemeChoice, library: [], ui: {} };
    }
  } catch {
    // ignore — opaque blob; bad JSON falls back to local/default.
  }
  return null;
}

// Serialize the v2 shape. Returns null when there's nothing to persist
// (default active, empty library, no UI overrides) so storage stays clean.
export function serializePersisted(state: PersistedTheme): string | null {
  const isEmpty =
    state.active.kind === "default" &&
    state.library.length === 0 &&
    Object.keys(state.ui).length === 0;
  if (isEmpty) return null;
  return JSON.stringify({
    v: 2,
    active: state.active,
    library: state.library,
    ui: state.ui,
  });
}
