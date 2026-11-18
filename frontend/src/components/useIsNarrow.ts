import { useEffect, useState } from "react";

// The phone layout: the sidebar is an icon rail that expands over the content,
// and the settings pages fall back to a single column.
//
// It needs a narrow screen AND a touch device. A desktop window dragged narrow
// keeps the full layout (labelled menu, tabs, split panes) at every width, so
// the app looks the same however far the window is shrunk. The same pair of
// conditions gates the matching rules in Layout.css and profile.css.
//
// Shared by Layout and SettingsShell so the two can't disagree about which side
// of the breakpoint they're on. They cooperate on the settings takeover — Layout
// hides the main sidebar, SettingsShell puts up the replacement rail — so a
// mismatch would strand the user with neither.
const NARROW_QUERY = "(max-width: 768px) and (pointer: coarse)";

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
