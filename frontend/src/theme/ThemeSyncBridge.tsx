// Bridges the (auth-unaware) CustomThemeContext to backend persistence.
//
// On user login, hydrates the full theme state (active choice + named library
// + UI overrides) from `user.theme_json` (delivered by /api/me). The hydrate
// happens once per user id — re-hydrating on every /api/me poll would clobber
// unsaved local changes.
//
// On any theme-state change, PUTs the serialized v2 blob to /api/me/theme —
// debounced (~600ms) so rapid library edits/renames don't spam the API, and
// only when authenticated and only when the value differs from what we last
// sent/received. The lastRemoteRef guard prevents the hydrate-then-PUT echo.
//
// The bridge renders its children unchanged — its only job is the side-effect
// coupling.

import { useEffect, useRef, type ReactNode } from "react";

import { putTheme } from "../api/profile";
import { useAuth } from "../auth/useAuth";
import { logger } from "../utils/logger";
import { useCustomTheme } from "./useCustomTheme";
import { parsePersisted, serializePersisted } from "./themeStorage";

const SYNC_DEBOUNCE_MS = 600;

export default function ThemeSyncBridge({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { choice, library, ui, hydrate } = useCustomTheme();
  const lastRemoteRef = useRef<string | null>(null);
  const hydratedForUserRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate from server when a new user lands. Only runs once per user id.
  useEffect(() => {
    if (!user) {
      hydratedForUserRef.current = null;
      lastRemoteRef.current = null;
      return;
    }
    if (hydratedForUserRef.current === user.id) return;
    hydratedForUserRef.current = user.id;
    const remote = parsePersisted(user.theme_json);
    if (remote) {
      lastRemoteRef.current = serializePersisted(remote);
      hydrate(remote);
    } else {
      // Server has no override. Treat current local state as "to be synced up"
      // so the PUT effect picks it up on the next tick.
      lastRemoteRef.current = null;
    }
  }, [user, hydrate]);

  // Push local changes up to the server (debounced, only when authenticated).
  useEffect(() => {
    if (!user) return;
    const serialized = serializePersisted({ active: choice, library, ui });
    if (serialized === lastRemoteRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      lastRemoteRef.current = serialized;
      putTheme(serialized).catch((err) => {
        logger.warn("theme sync to backend failed", err);
      });
    }, SYNC_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [choice, library, ui, user]);

  return <>{children}</>;
}
