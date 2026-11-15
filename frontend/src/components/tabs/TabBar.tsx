import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  TAB_MOVED_EVENT,
  TAB_OPEN_EVENT,
  TAB_TITLE_SOURCES,
  type TabOpenDetail,
} from "./tabsConfig";
import {
  activateTab,
  addTab,
  closeTab,
  initialState,
  insertTab,
  loadState,
  moveTab,
  saveState,
  setTitleFor,
  syncActivePath,
  tabTitle,
  type Tab,
  type TabsState,
  MAX_TABS,
} from "./tabsModel";
import { TAB_TITLE_EVENT, type TabTitleDetail } from "./useTabTitle";
import type { TabDragPayload } from "../paneDnd";
import TabStrip from "./TabStrip";
import TabSwitcher from "./TabSwitcher";
import { isTypingTarget } from "./isTypingTarget";

const NEW_TAB_PATH = "/";

function currentUrl(loc: { pathname: string; search: string; hash: string }) {
  return `${loc.pathname}${loc.search}${loc.hash}`;
}

type Props = {
  /** A tab drag started: Layout turns it into a pane drag, so the tab can be
   *  dropped past the middle of the page or onto the right group. */
  onPaneDragStart?: (
    e: DragEvent,
    tab: Tab,
    title: string,
    /** It's this strip's only tab. */
    isLast: boolean
  ) => void;
  onPaneDragEnd?: () => void;
  /** A tab from the right group was dropped into this strip (Layout removes it
   *  from the group). */
  onReceivedFromRight?: (payload: TabDragPayload) => void;
  /** Closing the last tab closes the whole pane (Cursor closes an editor group
   *  with its last tab). Unset → the last tab can't be closed. */
  onCloseLast?: (tabId: string) => void;
  /** Accessible name for the last tab's ×, which closes the pane. */
  closeLastLabel?: string;
  /** Controls pinned to the strip's right end (e.g. Upgrade). */
  trailing?: ReactNode;
};

/** The main view's tab strip. Each tab keeps its own URL; the active tab
 *  follows the router, "+" opens a new tab on Home. */
export default function TabBar({
  onPaneDragStart,
  onPaneDragEnd,
  onReceivedFromRight,
  onCloseLast,
  closeLastLabel = "Close pane",
  trailing,
}: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const url = currentUrl(location);

  const [state, setState] = useState<TabsState>(() => {
    const saved = loadState();
    // A deep link / reload lands on the active tab.
    return saved ? syncActivePath(saved, url) : initialState(url);
  });

  // Router → active tab, adjusted during render (React's "state from props"
  // pattern) rather than in an effect, so there's no extra render pass.
  const [syncedUrl, setSyncedUrl] = useState(url);
  if (syncedUrl !== url) {
    setSyncedUrl(url);
    setState((s) => syncActivePath(s, url));
  }

  useEffect(() => saveState(state), [state]);

  // Page-published titles (useTabTitle).
  useEffect(() => {
    const onTitle = (e: Event) => {
      const { pathname, title } = (e as CustomEvent<TabTitleDetail>).detail;
      setState((s) => setTitleFor(s, pathname, title));
    };
    window.addEventListener(TAB_TITLE_EVENT, onTitle);
    return () => window.removeEventListener(TAB_TITLE_EVENT, onTitle);
  }, []);

  // Latest state for event handlers. `go` also writes it eagerly, so several
  // events fired in one tick (closing a group re-opens each of its tabs here)
  // each build on the previous one.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // Where the router is (or is about to be): several `go`s in one tick must
  // compare against the previous one's navigation, not this render's URL.
  const urlRef = useRef(url);
  useEffect(() => {
    urlRef.current = url;
  }, [url]);

  const go = (next: TabsState) => {
    stateRef.current = next;
    setState(next);
    const target = next.tabs.find((t) => t.id === next.activeId);
    if (target && target.path !== urlRef.current) {
      urlRef.current = target.path;
      void navigate(target.path);
    }
  };
  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  });

  const titleOf = (tab: Tab) => tabTitle(tab, TAB_TITLE_SOURCES);
  const select = (id: string) => go(activateTab(state, id));
  const open = () => go(addTab(state, NEW_TAB_PATH));
  const close = (id: string) =>
    state.tabs.length <= 1 ? onCloseLast?.(id) : go(closeTab(state, id));

  useEffect(() => {
    // A tab dropped into the right group moves there, as in Cursor: it leaves
    // this strip, and if it was the active one the main view shows its
    // neighbour. The last tab stays (the main view always has one).
    const onMoved = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      goRef.current(closeTab(stateRef.current, id));
    };
    // A page coming back from the right group.
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<TabOpenDetail>).detail;
      const s = stateRef.current;
      if (d.replaceId && s.tabs.some((t) => t.id === d.replaceId)) {
        goRef.current({
          tabs: s.tabs.map((t) =>
            t.id === d.replaceId
              ? { id: t.id, path: d.path, title: d.title }
              : t
          ),
          activeId: d.replaceId,
        });
        return;
      }
      goRef.current(insertTab(s, { path: d.path, title: d.title }, d.index));
    };
    window.addEventListener(TAB_MOVED_EVENT, onMoved);
    window.addEventListener(TAB_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener(TAB_MOVED_EVENT, onMoved);
      window.removeEventListener(TAB_OPEN_EVENT, onOpen);
    };
  }, []);

  // Keyboard: Ctrl/Cmd+Alt+T new tab, Ctrl/Cmd+Alt+W close, Ctrl+Tab cycles
  // (wrapping), Cmd/Ctrl+Left/Right open the tab to the left/right (stopping
  // at the first/last tab).
  // (Plain Cmd+T/W belong to the browser and can't be intercepted there.)
  useEffect(() => {
    const step = (s: TabsState, by: number, wrap: boolean) => {
      const i = s.tabs.findIndex((t) => t.id === s.activeId);
      const n = s.tabs.length;
      const j = wrap ? (i + by + n) % n : i + by;
      if (j < 0 || j >= n || j === i) return;
      goRef.current(activateTab(s, s.tabs[j].id));
    };
    const onKey = (e: KeyboardEvent) => {
      const s = stateRef.current;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.altKey && e.code === "KeyT") {
        e.preventDefault();
        goRef.current(addTab(s, NEW_TAB_PATH));
      } else if (mod && e.altKey && e.code === "KeyW") {
        e.preventDefault();
        goRef.current(closeTab(s, s.activeId));
      } else if (e.ctrlKey && e.key === "Tab" && s.tabs.length > 1) {
        e.preventDefault();
        step(s, e.shiftKey ? -1 : 1, true);
      } else if (
        mod &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        s.tabs.length > 1 &&
        !isTypingTarget(e.target)
      ) {
        // In a text field Cmd+Left/Right is the OS's line start/end (and
        // Shift selects to it), so those keep their meaning there.
        e.preventDefault();
        step(s, e.key === "ArrowLeft" ? -1 : 1, false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <TabStrip
        stripId="main"
        ariaLabel="Open tabs"
        tabs={state.tabs}
        activeId={state.activeId}
        titleOf={titleOf}
        onSelect={select}
        onClose={close}
        canClose={state.tabs.length > 1 || !!onCloseLast}
        closeLabel={(_tab, title) =>
          state.tabs.length <= 1 && onCloseLast
            ? closeLastLabel
            : `Close ${title}`
        }
        onReorder={(from, to) => setState((s) => moveTab(s, from, to))}
        onReceive={(payload, index) => {
          go(
            insertTab(
              state,
              { path: payload.path, title: payload.title },
              index
            )
          );
          onReceivedFromRight?.(payload);
        }}
        onTabDragStart={(e, tab, title) =>
          onPaneDragStart?.(e, tab, title, state.tabs.length <= 1)
        }
        onTabDragEnd={onPaneDragEnd}
        onAdd={open}
        addDisabled={state.tabs.length >= MAX_TABS}
        trailing={trailing}
      />
      {/* Hold Ctrl+Option (Ctrl+Alt) to see every open tab, like Cmd+Tab. */}
      <TabSwitcher
        tabs={state.tabs}
        activeId={state.activeId}
        titleOf={titleOf}
        onPick={select}
      />
    </>
  );
}
