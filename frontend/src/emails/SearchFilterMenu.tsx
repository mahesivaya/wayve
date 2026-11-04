import { useEffect, useRef, useState } from "react";
import { FilterIcon } from "../icons";
import { SEARCH_SCOPES, searchScope } from "./searchScope";
import { EmailFolder } from "./types";

// The filter icon at the end of the emails search box: chooses where a search
// looks. Spam, drafts and trash are left out of all mail, so this is the way
// into them from a search.
export function SearchFilterMenu({
  activeFolder,
  onSelectFolder,
}: {
  activeFolder: EmailFolder;
  onSelectFolder: (folder: EmailFolder) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scope = searchScope(activeFolder);

  // Closes on Escape or a click outside the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        rootRef.current &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="email-search-filter" ref={rootRef}>
      <button
        type="button"
        className={`email-search-filter-btn${scope !== "all" ? " is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Search options"
        data-tooltip={open ? undefined : "Search options"}
        onClick={() => setOpen((value) => !value)}
      >
        <FilterIcon size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="email-select-menu" role="menu" aria-label="Search in">
          <div className="email-search-filter-title">Search in</div>
          {SEARCH_SCOPES.map(({ folder, label }) => (
            <button
              key={folder}
              type="button"
              role="menuitemradio"
              aria-checked={folder === scope}
              className="email-select-item"
              onClick={() => {
                setOpen(false);
                // Already searching here: stay put, so an Inbox search doesn't
                // land on All mail once it is cleared.
                if (folder !== scope) onSelectFolder(folder);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
