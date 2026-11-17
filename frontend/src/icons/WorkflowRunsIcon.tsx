// CI workflow mark for Code Repo's Actions section (bespoke — lucide has no
// pipeline glyph): a play button whose line branches into a row of passed jobs
// and a row of pending ones. Outlined like the lucide icons, inheriting color
// via `currentColor` and sized by the `size` prop.
export default function WorkflowRunsIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Trigger: a play button. */}
      <circle cx="5" cy="5" r="3.5" />
      <path d="M4 3.4 6.6 5 4 6.6Z" />
      {/* The line down from it, branching into the two rows. */}
      <path d="M5 8.5V16.5Q5 20 8.75 20" />
      <path d="M5 9.5Q5 12.5 8.75 12.5" />
      {/* Passed jobs. */}
      <circle cx="11.5" cy="12.5" r="2.75" />
      <path d="M10.3 12.6 11.2 13.4 12.7 11.8" />
      <path d="M14.25 12.5H16.75" />
      <circle cx="19.5" cy="12.5" r="2.75" />
      <path d="M18.3 12.6 19.2 13.4 20.7 11.8" />
      {/* Pending jobs. */}
      <circle cx="11.5" cy="20" r="2.75" />
      <circle cx="10.6" cy="20" r="0.35" fill="currentColor" />
      <circle cx="12.4" cy="20" r="0.35" fill="currentColor" />
      <path d="M16.1 20H16.75" />
      <circle cx="19.5" cy="20" r="2.75" />
    </svg>
  );
}
