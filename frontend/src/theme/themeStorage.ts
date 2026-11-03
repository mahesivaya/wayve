// Shared by the localStorage store and the backend sync bridge so both agree on
// the format and the v1→v2 migration. v1 stored a bare ThemeChoice; v2 wraps it
// as { v: 2, active, library, ui }. Old v1 blobs are migrated forward on read.

import { BW_DARK_INPUT } from "./blackAndWhite";
import type {
  PersistedTheme,
  SavedTheme,
  ThemeChoice,
  ThemeMode,
  UiOverrides,
} from "./customThemeShared";

export type { PersistedTheme };

export const STORAGE_KEY = "wayve-custom-theme-v2";

// Mirror of the currently applied light/dark mode, read by the pre-paint script
// in index.html before React mounts. Light (a white background) is the default
// for every visitor, so only "dark" is ever stored — a missing key, or the
// legacy "light" value, both mean light.
export const MODE_STORAGE_KEY = "wayve-theme";

export function readMode(): ThemeMode {
  try {
    if (localStorage.getItem(MODE_STORAGE_KEY) === "dark") return "dark";
  } catch {
    // ignore — storage may be blocked
  }
  return "light";
}

export function rememberMode(mode: ThemeMode) {
  try {
    if (mode === "dark") localStorage.setItem(MODE_STORAGE_KEY, "dark");
    else localStorage.removeItem(MODE_STORAGE_KEY);
  } catch {
    // ignore — storage may be blocked
  }
}

// Called on logout and session expiry. The theme belongs to the account, so it
// must not stay on the device for whoever signs in next.
export function forgetDeviceTheme() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(MODE_STORAGE_KEY);
  } catch {
    // ignore — storage may be blocked
  }
}

export const EMPTY_PERSISTED: PersistedTheme = {
  active: { kind: "default" },
  library: [],
  ui: {},
};

// Accounts can still hold these two presets, which no longer exist. Unknown
// presets paint as light, which would put "default-dark" accounts on white.
function upgradeChoice(choice: ThemeChoice): ThemeChoice {
  if (choice.kind !== "preset") return choice;
  if (choice.presetId === "default-light") return { kind: "default" };
  if (choice.presetId === "default-dark") {
    return { kind: "custom", mode: "dark", input: BW_DARK_INPUT };
  }
  return choice;
}

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
        active: upgradeChoice(obj.active),
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
      return { active: upgradeChoice(obj.choice), library: [], ui: {} };
    }

    // Legacy v1: the old backend wire format, a bare ThemeChoice.
    if (isThemeChoice(obj)) {
      return {
        active: upgradeChoice(obj as unknown as ThemeChoice),
        library: [],
        ui: {},
      };
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
