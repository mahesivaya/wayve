// Bridges the auth-unaware CustomThemeContext to backend persistence; it renders
// children unchanged and exists only for the side effects.
//
// Hydration runs once per user id: re-hydrating on every /api/me poll would
// clobber unsaved local changes. Pushes are debounced so rapid library edits
// don't spam the API, and lastRemoteRef suppresses the hydrate-then-PUT echo.

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
      // The server has no override, so leave the local state marked unsynced and
      // let the PUT effect push it up on the next tick.
      lastRemoteRef.current = null;
    }
  }, [user, hydrate]);

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
