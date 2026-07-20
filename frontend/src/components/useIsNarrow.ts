import { useEffect, useState } from "react";

// At or below this width the sidebar is an off-canvas overlay rather than a
// permanent rail, and the settings pages fall back to a single column.
//
// Shared by Layout and SettingsShell so the two can't disagree about which side
// of the breakpoint they're on. They cooperate on the settings takeover — Layout
// hides the main sidebar, SettingsShell puts up the replacement rail — so a
// mismatch would strand the user with neither.
const NARROW_QUERY = "(max-width: 768px)";

export function useIsNarrow(): boolean {
  const [isNarrow, setIsNarrow] = useState<boolean>(
    () =>
      typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isNarrow;
}
