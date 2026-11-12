import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  hasPaneDragData,
  readPaneDragData,
  type TabDragPayload,
  type TabStripId,
} from "../paneDnd";
import type { Tab } from "./tabsModel";
import "./TabBar.css";

const TAB_DND_MIME = "application/x-wayve-tab";

type Props = {
  stripId: TabStripId;
  tabs: Tab[];
  activeId: string | null;
  titleOf: (tab: Tab) => string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Accessible name of a tab's ×. */
  closeLabel?: (tab: Tab, title: string) => string;
  canClose?: boolean;
  onReorder: (from: number, to: number) => void;
  /** A tab from the OTHER strip was dropped here, before `index`. */
  onReceive: (payload: TabDragPayload, index: number) => void;
  /** Turns a tab drag into a pane drag (split / move between groups). */
  onTabDragStart?: (e: DragEvent, tab: Tab, title: string) => void;
  onTabDragEnd?: () => void;
  onAdd?: () => void;
  addDisabled?: boolean;
  trailing?: ReactNode;
  ariaLabel: string;
};

/** One Cursor-style tab strip (an editor group's tabs). Purely presentational:
 *  the owner keeps the tabs and decides what select/close/drop mean. */
export default function TabStrip({
  stripId,
  tabs,
  activeId,
  titleOf,
  onSelect,
  onClose,
  closeLabel = (_tab, title) => `Close ${title}`,
  canClose = true,
  onReorder,
  onReceive,
  onTabDragStart,
  onTabDragEnd,
  onAdd,
  addDisabled,
  trailing,
  ariaLabel,
}: Props) {
  // Index of the tab being dragged within THIS strip (null: none / foreign).
  const dragFrom = useRef<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  // Keep the active tab in view when it changes (e.g. "+" adds one past the
  // visible edge of a crowded strip).
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]'
    );
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  const endDrag = () => {
    dragFrom.current = null;
    setDropAt(null);
    onTabDragEnd?.();
  };

  const acceptsDrag = (e: DragEvent) =>
    dragFrom.current !== null || hasPaneDragData(e.dataTransfer);

  const dropBefore = (e: DragEvent, index: number) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropAt(null);
    if (dragFrom.current !== null) {
      const from = dragFrom.current;
      dragFrom.current = null;
      onReorder(from, Math.min(index, tabs.length - 1));
      return;
    }
    const payload = readPaneDragData(e.dataTransfer);
    if (payload?.kind === "tab" && payload.source !== stripId) {
      onReceive(payload, index);
    }
  };

  return (
    <div
      className="app-tabbar"
      role="tablist"
      aria-label={ariaLabel}
      data-strip={stripId}
      // Dropping on the empty end of the strip appends.
      onDragOver={(e) => {
        if (!acceptsDrag(e)) return;
        e.preventDefault();
        setDropAt(tabs.length);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDropAt(null);
        }
      }}
      onDrop={(e) => dropBefore(e, tabs.length)}
    >
      {/* Only the tabs scroll; "+" and the trailing controls stay pinned
          after them, so "+" is always reachable however many tabs are open. */}
      <div className="app-tabbar-tabs" ref={tabsRef}>
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          const title = titleOf(tab);
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={title}
              className={`app-tab${active ? " active" : ""}${dropAt === index ? " drop-target" : ""}`}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(tab.id);
                }
              }}
              // Middle-click closes, like a browser.
              onAuxClick={(e) => {
                if (e.button === 1 && canClose) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              draggable
              onDragStart={(e) => {
                dragFrom.current = index;
                e.dataTransfer.setData(TAB_DND_MIME, String(index));
                e.dataTransfer.effectAllowed = "move";
                onTabDragStart?.(e, tab, title);
              }}
              onDragOver={(e) => {
                if (!acceptsDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                setDropAt(index);
              }}
              onDrop={(e) => dropBefore(e, index)}
              onDragEnd={endDrag}
            >
              <span className="app-tab-title">{title}</span>
              {canClose && (
                <button
                  type="button"
                  className="app-tab-close"
                  aria-label={closeLabel(tab, title)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
        {dropAt === tabs.length && tabs.length > 0 && (
          <span className="app-tab-drop-end" aria-hidden="true" />
        )}
      </div>
      {onAdd && (
        <button
          type="button"
          className="app-tab-add"
          onClick={onAdd}
          disabled={addDisabled}
          aria-label="New tab"
          data-tooltip="New tab"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      )}
      {trailing && <div className="app-tabbar-trailing">{trailing}</div>}
    </div>
  );
}
