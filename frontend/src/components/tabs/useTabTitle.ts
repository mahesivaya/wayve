import { useEffect } from "react";
import { useLocation } from "react-router-dom";

export const TAB_TITLE_EVENT = "wayve:tab-title";

export type TabTitleDetail = { pathname: string; title: string | undefined };

/** Lets a page name its tab (e.g. "#5 Performance fix"). Pass null/undefined
 *  while loading to fall back to the route-derived title. */
export function useTabTitle(title: string | null | undefined): void {
  const { pathname } = useLocation();
  useEffect(() => {
    const detail: TabTitleDetail = { pathname, title: title || undefined };
    window.dispatchEvent(new CustomEvent(TAB_TITLE_EVENT, { detail }));
  }, [pathname, title]);
}
