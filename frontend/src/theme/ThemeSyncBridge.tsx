// Bridges the auth-unaware CustomThemeContext to backend persistence; it renders
// children unchanged and exists only for the side effects.
//
// The account's theme always wins over what the device holds, which may be left
// over from another account. A fresh login first sets a user built from the JWT
// with no theme_json (undefined, where /api/me gives a string or null), so
// neither effect runs until the profile has arrived.
//
// Hydration runs once per user id: re-hydrating on every /api/me poll would
// clobber unsaved local changes. Pushes are debounced so rapid library edits
// don't spam the API, and lastRemoteRef suppresses the hydrate-then-PUT echo.

import { useEffect, useRef, type ReactNode } from "react";

import { putTheme } from "../api/profile";
import { useAuth } from "../auth/useAuth";
import { logger } from "../utils/logger";
import { useCustomTheme } from "./useCustomTheme";
import {
  EMPTY_PERSISTED,
  parsePersisted,
  serializePersisted,
} from "./themeStorage";

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
    if (user.theme_json === undefined) return;
    if (hydratedForUserRef.current === user.id) return;
    hydratedForUserRef.current = user.id;
    const remote = parsePersisted(user.theme_json) ?? EMPTY_PERSISTED;
    lastRemoteRef.current = serializePersisted(remote);
    hydrate(remote);
  }, [user, hydrate]);

  useEffect(() => {
    if (!user || user.theme_json === undefined) return;
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
