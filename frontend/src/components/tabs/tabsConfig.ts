import { SPLIT_APPS } from "../LayoutConfig";
import type { TitleSource } from "./tabsModel";

// Routes outside SPLIT_APPS that still deserve a friendly tab label.
const EXTRA_SOURCES: TitleSource[] = [
  // Account home pages are simply "Home".
  { path: "/organization/home", label: "Home" },
  { path: "/platform/home", label: "Home" },
  { path: "/tickets", label: "Tickets" },
  { path: "/user-stories", label: "User stories" },
  { path: "/settings/general", label: "Settings" },
  { path: "/settings/shortcuts", label: "Shortcuts" },
  { path: "/settings/account", label: "Profile" },
  { path: "/billing", label: "Billing" },
  { path: "/platform", label: "Platform" },
  { path: "/teams", label: "Teams" },
];

/** Everything a tab title can be derived from (also used for split panes). */
export const TAB_TITLE_SOURCES: TitleSource[] = [
  ...SPLIT_APPS.map((a) => ({ path: a.path, label: a.label })),
  ...EXTRA_SOURCES,
];

/** Layout fires this (detail: tab id) when a dragged tab opened in a split. */
export const TAB_MOVED_EVENT = "wayve:tab-moved";

/** Layout fires this to put a page into the main strip (detail:
 *  TabOpenDetail), e.g. a tab dragged back from the right group. */
export const TAB_OPEN_EVENT = "wayve:tab-open";

export type TabOpenDetail = {
  path: string;
  title?: string;
  /** Insert before this index (default: after the active tab). */
  index?: number;
  /** Replace this tab in place instead of inserting (closing a group). */
  replaceId?: string;
};
