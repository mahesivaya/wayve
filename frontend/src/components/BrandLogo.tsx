// Fluxze brand mark — a layered hexagon "circuit" icon: concentric hexagons
// (scalable, decentralized layers), nodes on the outer ring (connected
// network), and a solid core hexagon (trust / core protocol). Hand-built as
// vector so it stays crisp at favicon size and scales to any header. No text
// is baked in — the wordmark is rendered separately next to it.
//
// `gradientId` is parameterized so multiple instances on one page (header +
// footer) don't share a single <linearGradient id>, which would be invalid
// SVG and can cause the second instance to render without its fill.
export default function BrandLogo({
  size = 28,
  className,
  gradientId = "fluxze-mark-gradient",
  title = "Fluxze",
}: {
  size?: number;
  className?: string;
  gradientId?: string;
  title?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientId} x1="50" y1="6" x2="50" y2="94" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#34D7EC" />
          <stop offset="1" stopColor="#2563EB" />
        </linearGradient>
      </defs>
      <g
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth="5"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        {/* Outer layer */}
        <path d="M94 50 L72 88.1 L28 88.1 L6 50 L28 11.9 L72 11.9 Z" />
        {/* Middle layer */}
        <path d="M80 50 L65 75.98 L35 75.98 L20 50 L35 24.02 L65 24.02 Z" strokeWidth="4" />
      </g>
      {/* Connected nodes on the outer ring */}
      <g fill={`url(#${gradientId})`}>
        <circle cx="94" cy="50" r="5" />
        <circle cx="72" cy="88.1" r="5" />
        <circle cx="28" cy="88.1" r="5" />
        <circle cx="6" cy="50" r="5" />
        <circle cx="28" cy="11.9" r="5" />
        <circle cx="72" cy="11.9" r="5" />
        {/* Solid core */}
        <path d="M65 50 L57.5 62.99 L42.5 62.99 L35 50 L42.5 37.01 L57.5 37.01 Z" />
      </g>
    </svg>
  );
}
