// Bug-report glyph — amber warning triangle with a dark `!`. Used by the header
// shortcut button and the Platform → Support sidebar entry. Intentionally
// two-tone, so the colors are hard-coded (not `currentColor`). Moved here from
// Layout.tsx as part of the central icon module.
export default function BugReportIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M11.13 3.3a1 1 0 0 1 1.74 0l9.4 16.3a1 1 0 0 1-.87 1.5H2.6a1 1 0 0 1-.87-1.5z"
        fill="#f5a623"
      />
      <rect
        x="10.85"
        y="8.5"
        width="2.3"
        height="7.2"
        rx="1.05"
        fill="#2d2d2d"
      />
      <circle cx="12" cy="18.4" r="1.35" fill="#2d2d2d" />
    </svg>
  );
}
