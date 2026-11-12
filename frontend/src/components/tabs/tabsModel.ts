// Pure state model for the app-wide tab strip (TabBar). Each tab remembers the
// full URL (path + search + hash) it was last on; the active tab always mirrors
// the router location. Kept free of React so it is trivially unit-testable.

export type Tab = {
  id: string;
  /** pathname + search + hash the tab was last showing. */
  path: string;
  /** Title a page published for this tab's pathname (see useTabTitle). */
  title?: string;
};

export type TabsState = { tabs: Tab[]; activeId: string };

export type TitleSource = { path: string; label: string };

export const STORAGE_KEY = "wayve.tabs.v1";
export const MAX_TABS = 20;

let seq = 0;
export function newTabId(): string {
  seq += 1;
  return `t${Date.now().toString(36)}${seq.toString(36)}`;
}

export function pathnameOf(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

export function initialState(path: string): TabsState {
  const tab = { id: newTabId(), path };
  return { tabs: [tab], activeId: tab.id };
}

/** The router moved: the active tab follows it. Its page title is dropped when
 *  the pathname changes (the new page publishes its own). */
export function syncActivePath(state: TabsState, path: string): TabsState {
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (!active || active.path === path) return state;
  const samePage = pathnameOf(active.path) === pathnameOf(path);
  return {
    ...state,
    tabs: state.tabs.map((t) =>
      t.id === active.id
        ? { id: t.id, path, title: samePage ? t.title : undefined }
        : t
    ),
  };
}

export function addTab(state: TabsState, path: string): TabsState {
  if (state.tabs.length >= MAX_TABS) return state;
  const tab = { id: newTabId(), path };
  const at = state.tabs.findIndex((t) => t.id === state.activeId);
  const tabs = [...state.tabs];
  tabs.splice(at === -1 ? tabs.length : at + 1, 0, tab);
  return { tabs, activeId: tab.id };
}

/** Inserts an existing page (a tab moved in from another strip) before
 *  `index` (default: after the active tab) and makes it active. */
export function insertTab(
  state: TabsState,
  page: { path: string; title?: string },
  index?: number
): TabsState {
  if (state.tabs.length >= MAX_TABS) return state;
  const tab: Tab = { id: newTabId(), path: page.path, title: page.title };
  const at = index ?? state.tabs.findIndex((t) => t.id === state.activeId) + 1;
  const tabs = [...state.tabs];
  tabs.splice(Math.max(0, Math.min(at, tabs.length)), 0, tab);
  return { tabs, activeId: tab.id };
}

/** Removes a tab, allowing the strip to become empty (a split group closes
 *  with its last tab). Null when nothing is left. */
export function removeTab(state: TabsState, id: string): TabsState | null {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (tabs.length === 0) return null;
  if (id !== state.activeId) return { ...state, tabs };
  return { tabs, activeId: tabs[Math.min(idx, tabs.length - 1)].id };
}

/** Closes a tab. The last tab can't be closed. Closing the active tab
 *  activates its right neighbour (or the left one at the end). */
export function closeTab(state: TabsState, id: string): TabsState {
  if (state.tabs.length <= 1) return state;
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (id !== state.activeId) return { ...state, tabs };
  const next = tabs[Math.min(idx, tabs.length - 1)];
  return { tabs, activeId: next.id };
}

export function activateTab(state: TabsState, id: string): TabsState {
  return state.tabs.some((t) => t.id === id)
    ? { ...state, activeId: id }
    : state;
}

export function moveTab(state: TabsState, from: number, to: number): TabsState {
  if (from === to || from < 0 || to < 0) return state;
  if (from >= state.tabs.length || to >= state.tabs.length) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  return { ...state, tabs };
}

/** Applies a page-published title to every tab currently on that pathname. */
export function setTitleFor(
  state: TabsState,
  pathname: string,
  title: string | undefined
): TabsState {
  let changed = false;
  const tabs = state.tabs.map((t) => {
    if (pathnameOf(t.path) !== pathname || t.title === title) return t;
    changed = true;
    return { ...t, title };
  });
  return changed ? { ...state, tabs } : state;
}

function prettify(segment: string): string {
  const s = decodeURIComponent(segment).replace(/[-_]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

const isRecordId = (segment: string) => /^\d+$/.test(segment);

/** Display title — just the page's own name, no breadcrumb ("Home", not
 *  "Platform › Home"): the page-published title if any, else the label of the
 *  route it is on, else its last path segment. A record page without a
 *  published title yet reads "<section> #<id>" (e.g. "User Stories #12"). */
export function tabTitle(tab: Tab, sources: TitleSource[]): string {
  if (tab.title) return tab.title;
  const pathname = pathnameOf(tab.path).replace(/\/+$/, "");
  if (pathname === "") {
    return sources.find((s) => s.path === "/")?.label ?? "Home";
  }
  const labelFor = (path: string) =>
    sources.find((s) => s.path !== "/" && s.path === path)?.label;

  const exact = labelFor(pathname);
  if (exact) return exact;

  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (isRecordId(last) && segments.length > 1) {
    const parentPath = `/${segments.slice(0, -1).join("/")}`;
    const parent =
      labelFor(parentPath) ?? prettify(segments[segments.length - 2]);
    return `${parent} #${last}`;
  }
  return prettify(last);
}

export function loadState(): TabsState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TabsState>;
    if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return null;
    const tabs = parsed.tabs
      .filter(
        (t): t is Tab =>
          !!t &&
          typeof t.id === "string" &&
          typeof t.path === "string" &&
          t.path.startsWith("/")
      )
      .slice(0, MAX_TABS);
    if (tabs.length === 0) return null;
    const activeId = tabs.some((t) => t.id === parsed.activeId)
      ? (parsed.activeId as string)
      : tabs[0].id;
    return { tabs, activeId };
  } catch {
    return null;
  }
}

export function saveState(state: TabsState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — tabs just won't survive a reload */
  }
}
