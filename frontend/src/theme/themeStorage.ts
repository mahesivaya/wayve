// Shared by the localStorage store and the backend sync bridge so both agree on
// the format and the v1→v2 migration. v1 stored a bare ThemeChoice; v2 wraps it
// as { v: 2, active, library, ui }. Old v1 blobs are migrated forward on read.

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

// Tolerates garbage: an unparseable blob yields null rather than throwing.
export function parsePersisted(
  json: string | null | undefined
): PersistedTheme | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;

    if (obj.v === 2 && isThemeChoice(obj.active)) {
      return {
        active: obj.active,
        library: Array.isArray(obj.library)
          ? (obj.library.filter(
              (t) =>
                t &&
                typeof t === "object" &&
                typeof (t as SavedTheme).id === "string"
            ) as SavedTheme[])
          : [],
        ui: obj.ui && typeof obj.ui === "object" ? (obj.ui as UiOverrides) : {},
      };
    }

    // Legacy v1: the old localStorage wrapper.
    if (isThemeChoice(obj.choice)) {
      return { active: obj.choice, library: [], ui: {} };
    }

    // Legacy v1: the old backend wire format, a bare ThemeChoice.
    if (isThemeChoice(obj)) {
      return { active: obj as unknown as ThemeChoice, library: [], ui: {} };
    }
  } catch {
    // ignore — opaque blob; bad JSON falls back to local/default.
  }
  return null;
}

// Returns null when there is nothing to persist, so storage stays clean.
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
