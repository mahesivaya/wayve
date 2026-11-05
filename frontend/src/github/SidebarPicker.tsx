import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// The repository and branch pickers: a button showing the choice, and a list
// styled by the app rather than the browser's own dropdown.
export function SidebarPicker<T extends string | number>({
  label,
  listLabel,
  icon,
  value,
  options,
  onChange,
}: {
  // Names the button for screen readers, as nothing visible says what it picks.
  label: string;
  listLabel: string;
  icon: ReactNode;
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A choice missing from the list still names itself on the button.
  const current =
    options.find((option) => option.value === value)?.label ??
    String(value ?? "");

  return (
    <div className="github-sidebar-branch" ref={rootRef}>
      <button
        type="button"
        className="github-branch-trigger"
        aria-label={`${label}: ${current}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((isOpen) => !isOpen)}
      >
        {icon}
        <span className="github-branch-name">{current}</span>
        <span
          className={`github-branch-caret ${open ? "open" : ""}`}
          aria-hidden="true"
        >
          ⌄
        </span>
      </button>
      {open && (
        <ul
          className="github-branch-menu"
          role="listbox"
          aria-label={listLabel}
        >
          {options.map((option) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
            >
              <button
                type="button"
                className={`github-branch-option ${option.value === value ? "active" : ""}`}
                title={option.label}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="github-branch-name">{option.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
