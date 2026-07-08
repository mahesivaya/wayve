import { useEffect, useRef } from "react";

// Auto sign-out after this long with no user interaction. 15 minutes.
export const IDLE_LIMIT_MS = 15 * 60 * 1000;

// Shared across tabs so activity in ANY tab keeps the whole session alive (the
// auth token/cookie is shared, so one tab timing out would end the session for
// all of them). Also lets a logout in one tab be noticed by the others.
const ACTIVITY_KEY = "wayve-last-activity";
// Don't hammer localStorage on every mousemove — persist at most this often.
const WRITE_THROTTLE_MS = 5_000;
// How often we check the elapsed-idle time. Coarse on purpose (cheap).
const CHECK_INTERVAL_MS = 15_000;

const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

/**
 * Sign the user out after {@link IDLE_LIMIT_MS} of inactivity. Only runs while
 * `enabled` (i.e. logged in); `onIdle` performs the actual logout. Activity is
 * shared across tabs via localStorage, so being active anywhere resets the clock
 * everywhere.
 */
export function useIdleLogout(enabled: boolean, onIdle: () => void): void {
  // Keep the latest callback without re-subscribing the listeners every render.
  const onIdleRef = useRef(onIdle);
  useEffect(() => {
    onIdleRef.current = onIdle;
  }, [onIdle]);

  useEffect(() => {
    if (!enabled) return;

    let last = Date.now();
    let lastWrite = 0;
    let firedOnce = false;

    const persist = (t: number) => {
      try {
        localStorage.setItem(ACTIVITY_KEY, String(t));
      } catch {
        /* storage unavailable — per-tab timing still works */
      }
    };
    persist(last);

    const markActive = () => {
      last = Date.now();
      if (last - lastWrite > WRITE_THROTTLE_MS) {
        lastWrite = last;
        persist(last);
      }
    };

    // Another tab's activity (or its own idle write) resets our clock too.
    const onStorage = (e: StorageEvent) => {
      if (e.key === ACTIVITY_KEY && e.newValue) {
        const t = Number(e.newValue);
        if (Number.isFinite(t) && t > last) last = t;
      }
    };

    const check = () => {
      // Reconcile with the shared value in case another tab was the active one.
      try {
        const stored = Number(localStorage.getItem(ACTIVITY_KEY));
        if (Number.isFinite(stored) && stored > last) last = stored;
      } catch {
        /* ignore */
      }
      if (!firedOnce && Date.now() - last >= IDLE_LIMIT_MS) {
        firedOnce = true; // guard against a double-fire before unmount
        onIdleRef.current();
      }
    };

    ACTIVITY_EVENTS.forEach((ev) =>
      window.addEventListener(ev, markActive, { passive: true })
    );
    window.addEventListener("storage", onStorage);
    const interval = window.setInterval(check, CHECK_INTERVAL_MS);

    return () => {
      ACTIVITY_EVENTS.forEach((ev) =>
        window.removeEventListener(ev, markActive)
      );
      window.removeEventListener("storage", onStorage);
      window.clearInterval(interval);
    };
  }, [enabled]);
}
