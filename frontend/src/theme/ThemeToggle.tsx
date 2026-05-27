// Header color-wheel button. Click opens the ThemeCustomizer as a dropdown
// panel anchored under the button — preset gallery + custom OKLCH controls
// + light/dark toggle, all in one place. Close on outside click or Escape.

import { useEffect, useRef, useState } from "react";

import ThemeCustomizer from "./ThemeCustomizer";
import { useTheme } from "./useTheme";
import "./themeToggle.css";

interface Props {
  className?: string;
}

export default function ThemeToggle({ className }: Props) {
  const { resolved } = useTheme();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="theme-toggle-container" ref={containerRef}>
      <button
        type="button"
        className={`theme-toggle theme-toggle--${resolved} ${className ?? ""}`.trim()}
        onClick={() => setOpen((o) => !o)}
        title="Customize appearance"
        aria-label="Customize appearance"
        aria-haspopup="dialog"
        aria-expanded={open}
      />
      {open && (
        <div
          className="theme-toggle-dropdown"
          role="dialog"
          aria-label="Appearance"
        >
          <ThemeCustomizer />
        </div>
      )}
    </div>
  );
}
