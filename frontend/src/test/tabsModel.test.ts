import { describe, expect, it, beforeEach } from "vitest";
import {
  addTab,
  closeTab,
  initialState,
  loadState,
  moveTab,
  saveState,
  setTitleFor,
  syncActivePath,
  tabTitle,
  STORAGE_KEY,
} from "../components/tabs/tabsModel";

const SOURCES = [
  { path: "/", label: "Home" },
  { path: "/platform/home", label: "Home" },
  { path: "/tickets", label: "Tickets" },
  { path: "/user-stories", label: "User stories" },
];

describe("tabsModel", () => {
  beforeEach(() => window.localStorage.clear());

  it("active tab follows the router and drops a stale page title", () => {
    let s = initialState("/tickets/5");
    s = setTitleFor(s, "/tickets/5", "#5 Test");
    expect(tabTitle(s.tabs[0], SOURCES)).toBe("#5 Test");
    s = syncActivePath(s, "/tickets/5?tab=ai");
    expect(s.tabs[0].title).toBe("#5 Test");
    s = syncActivePath(s, "/tickets");
    expect(s.tabs[0].title).toBeUndefined();
    expect(tabTitle(s.tabs[0], SOURCES)).toBe("Tickets");
  });

  it("adds after the active tab and closes to the neighbour", () => {
    let s = initialState("/tickets");
    const first = s.activeId;
    s = addTab(s, "/");
    const second = s.activeId;
    expect(s.tabs.map((t) => t.id)).toEqual([first, second]);
    s = closeTab(s, second);
    expect(s.activeId).toBe(first);
    // Last tab can't be closed.
    expect(closeTab(s, first)).toBe(s);
  });

  it("closing an inactive tab keeps the active one", () => {
    let s = initialState("/a");
    const a = s.activeId;
    s = addTab(s, "/b");
    const b = s.activeId;
    s = closeTab(s, a);
    expect(s.activeId).toBe(b);
    expect(s.tabs).toHaveLength(1);
  });

  it("reorders tabs", () => {
    let s = initialState("/a");
    s = addTab(s, "/b");
    s = addTab(s, "/c");
    s = moveTab(s, 2, 0);
    expect(s.tabs.map((t) => t.path)).toEqual(["/c", "/a", "/b"]);
  });

  it("derives titles from routes", () => {
    const t = (path: string) => tabTitle({ id: "x", path }, SOURCES);
    expect(t("/")).toBe("Home");
    // Just the page's name — no "Section › Page" breadcrumb.
    expect(t("/tickets")).toBe("Tickets");
    expect(t("/platform/home")).toBe("Home");
    expect(t("/platform/api-keys")).toBe("Api keys");
    expect(t("/logs/audit")).toBe("Audit");
    // A record page shows its section + id until the page names itself.
    expect(t("/user-stories/12")).toBe("User stories #12");
  });

  it("persists and ignores corrupt storage", () => {
    const s = addTab(initialState("/a"), "/b");
    saveState(s);
    expect(loadState()).toEqual(s);
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadState()).toBeNull();
  });
});
