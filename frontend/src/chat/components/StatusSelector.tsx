import { useEffect, useRef, useState } from "react";
import { getPresence, setChatStatus, type ChatStatus } from "../../api/chat";
import { logger } from "../../utils/logger";

// The three selectable modes, in menu order, each with its dot color class.
const OPTIONS: { value: ChatStatus; label: string; cls: string }[] = [
  { value: "active", label: "Active", cls: "online" },
  { value: "dnd", label: "Do Not Disturb", cls: "dnd" },
  { value: "away", label: "Away", cls: "away" },
];

const labelOf = (s: ChatStatus) =>
  OPTIONS.find((o) => o.value === s)?.label ?? "Active";
const clsOf = (s: ChatStatus) =>
  OPTIONS.find((o) => o.value === s)?.cls ?? "online";

/**
 * The current user's own presence-status picker, shown above the Messages
 * search bar. Seeds from the server so a reload reflects the real status, then
 * updates optimistically (rolling back if the PUT fails).
 */
export default function StatusSelector({ myUserId }: { myUserId: number }) {
  const [status, setStatus] = useState<ChatStatus>("active");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Seed the real status once (the presence snapshot carries our own row).
  useEffect(() => {
    if (!myUserId) return;
    let alive = true;
    void getPresence([myUserId])
      .then((rows) => {
        const mine = rows.find((r) => r.user_id === myUserId);
        if (alive && mine?.status) setStatus(mine.status);
      })
      .catch(() => {
        // Best-effort: leave the default "active" if the seed fails.
      });
    return () => {
      alive = false;
    };
  }, [myUserId]);

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

  const choose = (next: ChatStatus) => {
    setOpen(false);
    if (next === status) return;
    const prev = status;
    setStatus(next); // optimistic
    void setChatStatus(next).catch((err) => {
      logger.error("set chat status failed", err);
      setStatus(prev); // roll back
    });
  };

  return (
    <div className="status-selector" ref={wrapRef}>
      <button
        type="button"
        className="status-selector-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`presence-dot ${clsOf(status)}`} aria-hidden="true" />
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
  );
}
