import { useEffect, useState } from "react";

// Whether to use the separate phone layout: an icon rail that expands over the
// content, the older account menu, no tabs, and the settings pages as one
// stacked column.
//
// That layout is switched off. The app keeps the same frame at every width and
// on every device — labelled sidebar, the settings menu in it, tabs, split
// panes — so a narrowed window or a phone looks like the full-screen app. A
// small screen gets room back by collapsing the sidebar with its own toggle.
//
// Layout, Settings and SettingsShell still read this, so their phone branches
// stay in step with each other; the phone-only rules in Layout.css are gone,
// and would have to come back with it.
export function useIsNarrow(): boolean {
  return false;
}

// A phone-sized touch screen. It gets the same layout as everything else, with
// two allowances for its width: the sidebar starts collapsed, and when opened
// it is drawn over the page instead of squeezing it (see Layout).
export const PHONE_QUERY = "(max-width: 768px) and (pointer: coarse)";

export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(PHONE_QUERY).matches
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsPhone(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isPhone;
}
