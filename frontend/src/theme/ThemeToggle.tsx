// Compact header-friendly dark-mode toggle. Renders a sun icon when the
// page is in dark mode (click to go light) and a moon when in light mode.
// Use anywhere in the app — it carries its own state via `useTheme`.

import { useTheme } from "./useTheme";
import "./themeToggle.css";

interface Props {
  className?: string;
}

export default function ThemeToggle({ className }: Props) {
  const { resolved, toggle } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className={`theme-toggle ${className ?? ""}`.trim()}
      onClick={toggle}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
    >
      {resolved === "dark" ? (
        // Sun — clicking goes back to light.
        <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18">
          <circle cx="12" cy="12" r="4" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v3" />
            <path d="M12 19v3" />
            <path d="M2 12h3" />
            <path d="M19 12h3" />
            <path d="M4.5 4.5l2 2" />
            <path d="M17.5 17.5l2 2" />
            <path d="M19.5 4.5l-2 2" />
            <path d="M6.5 17.5l-2 2" />
          </g>
        </svg>
      ) : (
        // Crescent moon — clicking goes to dark.
        <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18">
          <path
            d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"
            fill="currentColor"
          />
        </svg>
      )}
    </button>
  );
}
