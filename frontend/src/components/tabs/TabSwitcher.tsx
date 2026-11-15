import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isTypingTarget } from "./isTypingTarget";
import type { Tab } from "./tabsModel";
import "./TabSwitcher.css";

type Props = {
  tabs: Tab[];
  activeId: string | null;
  titleOf: (tab: Tab) => string;
  onPick: (id: string) => void;
};

const isSwitchModifier = (key: string) => key === "Control" || key === "Alt";

// Off a Mac, AltGr arrives as Ctrl+Alt and types characters (e.g. @), so the
// switcher must stay out of text fields there. On a Mac Ctrl+Option never
// types anything, so it works from a text field too (e.g. the Home AI box).
const isMac = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * The open-tabs switcher, like macOS's Cmd+Tab app switcher. Holding
 * Ctrl+Option (Ctrl+Alt elsewhere) shows every open tab with the current one
 * highlighted; while still holding, Left/Right or Tab/Shift+Tab move the
 * highlight (wrapping), and letting go opens the highlighted tab. Escape, or
 * the window losing focus, closes it without switching.
 *
 * Off a Mac it never opens from a text field: on Windows, AltGr arrives as
 * Ctrl+Alt and is how many layouts type characters such as @.
 */
export default function TabSwitcher({
  tabs,
  activeId,
  titleOf,
  onPick,
}: Props) {
  // The highlighted tab's index while the switcher is open; null when closed.
  const [index, setIndexState] = useState<number | null>(null);
  // Mirrors `index` for the key listeners, which outlive renders.
  const indexRef = useRef<number | null>(null);
  const setIndex = (next: number | null) => {
    indexRef.current = next;
    setIndexState(next);
  };
  const setIndexRef = useRef(setIndex);
  const latest = useRef({ tabs, activeId, onPick });
  useEffect(() => {
    latest.current = { tabs, activeId, onPick };
    setIndexRef.current = setIndex;
  });

  useEffect(() => {
    const set = (next: number | null) => setIndexRef.current(next);

    const onDown = (e: KeyboardEvent) => {
      const { tabs: list, activeId: current } = latest.current;
      const open = indexRef.current;

      if (open === null) {
        if (
          isSwitchModifier(e.key) &&
          e.ctrlKey &&
          e.altKey &&
          !e.metaKey &&
          !e.shiftKey &&
          !e.repeat &&
          list.length > 1 &&
          (isMac() || !isTypingTarget(e.target))
        ) {
          const i = list.findIndex((t) => t.id === current);
          set(i < 0 ? 0 : i);
        }
        return;
      }

      // Open: the switcher owns the keyboard, so nothing else (e.g. TabBar's
      // own Ctrl+Tab) also acts on these keys.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        set(null);
        return;
      }
      let step = 0;
      if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) step = 1;
      else if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey))
        step = -1;
      if (step !== 0) {
        e.preventDefault();
        e.stopPropagation();
        const n = list.length;
        set((open + step + n) % n);
      }
    };

    const onUp = (e: KeyboardEvent) => {
      const open = indexRef.current;
      if (open === null || !isSwitchModifier(e.key)) return;
      const { tabs: list, activeId: current, onPick: pick } = latest.current;
      const target = list[open];
      set(null);
      if (target && target.id !== current) pick(target.id);
    };

    const onBlur = () => set(null);

    // Capture phase on window: runs before the document-level shortcut
    // listeners, so stopPropagation keeps them out while the switcher is open.
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  if (index === null) return null;

  return createPortal(
    <div className="tab-switcher-backdrop">
      <div className="tab-switcher" role="listbox" aria-label="Open tabs">
        {tabs.map((tab, i) => (
          <div
            key={tab.id}
            role="option"
            aria-selected={i === index}
            className={`tab-switcher-item${i === index ? " selected" : ""}${
              tab.id === activeId ? " current" : ""
            }`}
            onMouseEnter={() => setIndex(i)}
            // mousedown, not click: the keys are still held, and the keyup
            // that follows a click would otherwise reopen the highlighted tab.
            onMouseDown={(e) => {
              e.preventDefault();
              setIndex(null);
              if (tab.id !== activeId) onPick(tab.id);
            }}
          >
            <span className="tab-switcher-title">{titleOf(tab)}</span>
            <span className="tab-switcher-path">{tab.path}</span>
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
}
