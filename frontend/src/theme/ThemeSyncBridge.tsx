// Bridges the (auth-unaware) CustomThemeContext to backend persistence.
//
// On user login, hydrates the theme from `user.theme_json` (delivered by
// /api/me). The hydrate happens once per user id — re-hydrating on every
// /api/me poll would clobber unsaved local changes.
//
// On every theme choice change, PUTs the serialized choice to
// /api/me/theme — but only when the user is authenticated and only when
// the value differs from what we last sent/received. The
// lastRemoteRef guard prevents the hydrate-then-PUT echo: after we apply
// a server-sent theme, we immediately mark it as already-remote so the
// subsequent change effect skips the redundant PUT.
//
// The bridge renders its children unchanged — its only job is the
// side-effect coupling.

import { useEffect, useRef, type ReactNode } from "react";

import { putTheme } from "../api/profile";
import { useAuth } from "../auth/useAuth";
import { logger } from "../utils/logger";
import { useCustomTheme } from "./useCustomTheme";
import type { ThemeChoice } from "./customThemeShared";

function serialize(choice: ThemeChoice): string | null {
  return choice.kind === "default" ? null : JSON.stringify(choice);
}

function parseChoice(json: string | null | undefined): ThemeChoice | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as ThemeChoice;
    if (parsed.kind === "default" || parsed.kind === "preset" || parsed.kind === "custom") {
      return parsed;
    }
  } catch {
    // ignore — server-side blob is opaque; bad JSON falls back to local.
  }
  return null;
}

export default function ThemeSyncBridge({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { choice, setChoice } = useCustomTheme();
  const lastRemoteRef = useRef<string | null>(null);
  const hydratedForUserRef = useRef<number | null>(null);

  // Hydrate from server when a new user lands. Only runs once per user id.
  useEffect(() => {
    if (!user) {
      hydratedForUserRef.current = null;
      lastRemoteRef.current = null;
      return;
    }
    if (hydratedForUserRef.current === user.id) return;
    hydratedForUserRef.current = user.id;
    const remote = parseChoice(user.theme_json);
    if (remote) {
      lastRemoteRef.current = serialize(remote);
      setChoice(remote);
    } else {
      // Server has no override. Treat current local choice as "to be synced
      // up" so the PUT effect picks it up on the next tick.
      lastRemoteRef.current = null;
    }
  }, [user, setChoice]);

  // Push local changes up to the server (only when authenticated).
  useEffect(() => {
    if (!user) return;
    const serialized = serialize(choice);
    if (serialized === lastRemoteRef.current) return;
    lastRemoteRef.current = serialized;
    putTheme(serialized).catch((err) => {
      logger.warn("theme sync to backend failed", err);
    });
  }, [choice, user]);

  return <>{children}</>;
}
