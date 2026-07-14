import { useEffect, useRef } from "react";

export const IDLE_LIMIT_MS = 15 * 60 * 1000;

// Shared across tabs so activity in any tab keeps the whole session alive. The
// auth token is shared, so one tab timing out would otherwise end the session
// for all of them.
const ACTIVITY_KEY = "wayve-last-activity";
// Persist at most this often, rather than on every mousemove.
const WRITE_THROTTLE_MS = 5_000;
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
 * Sign the user out after {@link IDLE_LIMIT_MS} of inactivity. Runs only while
 * `enabled`, and activity in any tab resets the clock in all of them.
 */
export function useIdleLogout(enabled: boolean, onIdle: () => void): void {
  // Hold the latest callback without re-subscribing the listeners every render.
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
        /* Storage unavailable; per-tab timing still works. */
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

    // Another tab's activity resets this tab's clock too.
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
        firedOnce = true; // Guards against a double-fire before unmount.
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
