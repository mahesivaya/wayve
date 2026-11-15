import { useEffect, useRef, useState } from "react";
import {
  STATUS_OPTIONS as OPTIONS,
  chooseMyStatus,
  statusClass as clsOf,
  statusLabel as labelOf,
  useMyStatus,
} from "../myStatus";

/**
 * The current user's own presence-status picker, shown above the Messages
 * search bar. Shares one store (../myStatus) with the account menu, so setting
 * it in either place shows in both; updates optimistically, rolling back if the
 * PUT fails.
 */
export default function StatusSelector({ myUserId }: { myUserId: number }) {
  const status = useMyStatus(myUserId);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = (next: (typeof OPTIONS)[number]["value"]) => {
    setOpen(false);
    void chooseMyStatus(next);
  };

  return (
    <div className="status-selector" ref={wrapRef}>
      <span className="status-selector-heading">Status:</span>
      <div className="status-selector-control">
        <button
          type="button"
          className="status-selector-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span
            className={`presence-dot ${clsOf(status)}`}
            aria-hidden="true"
          />
          <span className="status-selector-label">{labelOf(status)}</span>
          <span className="status-selector-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {open && (
          <ul className="status-selector-menu" role="listbox">
            {OPTIONS.map((o) => (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === status}
                className={`status-selector-option${o.value === status ? " is-selected" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o.value);
                }}
              >
                <span className={`presence-dot ${o.cls}`} aria-hidden="true" />
                {o.label}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
