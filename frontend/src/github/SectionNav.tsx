import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { fittingTabs, splitTabs } from "./sectionTabs";

export type NavSection<Id extends string> = {
  id: Id;
  label: string;
  icon: string;
  count?: ReactNode;
};

const Inner = ({ item }: { item: NavSection<string> }) => (
  <>
    <span className="github-sidebar-icon" aria-hidden="true">
      {item.icon}
    </span>
    <span className="github-sidebar-label">{item.label}</span>
    {item.count !== undefined && (
      <span className="github-sidebar-count">{item.count}</span>
    )}
  </>
);

// A vertical list in the wide layout's rail. Once the page narrows, githubRepo.css
// turns it into a row like GitHub's tabs, and what doesn't fit moves under "More".
// The stylesheet decides which: this only reads the result, so the two can't
// disagree about the breakpoint.
export function SectionNav<Id extends string>({
  items,
  active,
  onSelect,
}: {
  items: NavSection<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
}) {
  const navRef = useRef<HTMLElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const moreRootRef = useRef<HTMLDivElement | null>(null);
  const [isRow, setIsRow] = useState(false);
  const [fit, setFit] = useState(items.length);
  const [menuOpen, setMenuOpen] = useState(false);

  // A count or section changing changes the widths to fit.
  const widthsKey = items
    .map((item) => `${item.id}:${String(item.count)}`)
    .join();

  // An observer reports once as soon as it starts, before the first paint, so
  // this covers the initial layout and each change of the key too.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(nav);
      const row = style.flexDirection === "row";
      setIsRow(row);
      const sizes = measureRef.current?.children;
      if (!row || !sizes || sizes.length === 0) return;
      const widths = Array.from(sizes).map(
        (el) => el.getBoundingClientRect().width
      );
      const moreWidth = widths.pop() ?? 0;
      const available =
        nav.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      setFit(
        fittingTabs(
          widths,
          moreWidth,
          available,
          parseFloat(style.columnGap) || 0
        )
      );
    });
    observer.observe(nav);
    return () => observer.disconnect();
  }, [isRow, widthsKey]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!moreRootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // At least the open section stays on the row, however tight it gets.
  const { shown, more } = isRow
    ? splitTabs(items, Math.max(fit, 1), active)
    : { shown: items, more: [] as NavSection<Id>[] };

  return (
    <nav
      ref={navRef}
      className="github-sidebar-card github-section-nav"
      aria-label="Repository sections"
    >
      {shown.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`github-sidebar-link ${active === item.id ? "active" : ""}`}
          aria-current={active === item.id ? "page" : undefined}
          onClick={() => onSelect(item.id)}
        >
          <Inner item={item} />
        </button>
      ))}
      {more.length > 0 && (
        <div className="github-section-more" ref={moreRootRef}>
          <button
            type="button"
            className="github-sidebar-link"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            More <span aria-hidden="true">▾</span>
          </button>
          {menuOpen && (
            <div className="github-section-menu" role="menu" aria-label="More">
              {more.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="github-section-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onSelect(item.id);
                  }}
                >
                  <Inner item={item} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Unseen copies of every tab, because one under "More" has no width of its
          own to read when deciding whether it now fits. The last is "More". */}
      {isRow && (
        <div className="github-section-measure" ref={measureRef} aria-hidden>
          {items.map((item) => (
            <span key={item.id} className="github-sidebar-link">
              <Inner item={item} />
            </span>
          ))}
          <span className="github-sidebar-link">More ▾</span>
        </div>
      )}
    </nav>
  );
}
