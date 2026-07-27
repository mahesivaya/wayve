// Brand marks as inline SVG, since no logo assets ship in the repo. They are
// approximate: swap in official logos if exact marks are ever needed. Rendered on
// a white tile so dark marks stay visible in either theme.
export function BrandIcon({ name }: { name: string }) {
  switch (name) {
    case "jira":
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path
            fill="#2684FF"
            d="M21.1 11.4 12.7 3a1 1 0 0 0-1.4 0L9.7 4.6l7 7-7 7 1.6 1.6a1 1 0 0 0 1.4 0l8.4-8.4a.85.85 0 0 0 0-1.4z"
          />
          <path
            fill="#2684FF"
            opacity="0.6"
            d="M14.6 11.4 6.2 3a1 1 0 0 0-1.4 0L3.2 4.6l7 7-7 7 1.6 1.6a1 1 0 0 0 1.4 0l8.4-8.4a.85.85 0 0 0 0-1.4z"
          />
        </svg>
      );
    case "github":
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path
            fill="#181717"
            d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0C17.3 4.3 18.3 4.6 18.3 4.6c.6 1.5.2 2.7.1 3 .8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"
          />
        </svg>
      );
    case "gmail":
      return (
        <svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true">
          <path fill="#4285F4" d="M3 19h3V11l-3-2.3V17.5A1.5 1.5 0 0 0 3 19z" />
          <path
            fill="#34A853"
            d="M18 19h3a1.5 1.5 0 0 0 1.5-1.5V8.7L18 11v8z"
          />
          <path
            fill="#FBBC05"
            d="M18 5.6V11l4.5-3.4V6.5A1.5 1.5 0 0 0 20.1 5L18 5.6z"
          />
          <path fill="#C5221F" d="M6 11V5.6l6 4.4 6-4.4V11l-6 4.4L6 11z" />
          <path
            fill="#EA4335"
            d="M1.5 6.5v1.1L6 11V5.6l-2.1-1.6A1.5 1.5 0 0 0 1.5 6.5z"
          />
        </svg>
      );
    case "outlook":
      return (
        <svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true">
          <path
            fill="#0364B8"
            d="M22 7.5v9a1 1 0 0 1-1 1h-9V6h9a1 1 0 0 1 1 1.5z"
          />
          <path
            fill="#fff"
            d="M12.6 9h8.4v1.4l-4.2 2.6-4.2-2.6V9z"
            opacity="0.85"
          />
          <rect
            x="1.5"
            y="4.5"
            width="11.5"
            height="15"
            rx="2.4"
            fill="#0F78D4"
          />
          <ellipse
            cx="7.25"
            cy="12"
            rx="2.7"
            ry="3.3"
            fill="none"
            stroke="#fff"
            strokeWidth="1.9"
          />
        </svg>
      );
    case "slack":
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <rect x="10" y="2.5" width="3.6" height="9" rx="1.8" fill="#36C5F0" />
          <rect
            x="2.5"
            y="10.4"
            width="9"
            height="3.6"
            rx="1.8"
            fill="#2EB67D"
          />
          <rect
            x="12.5"
            y="12.5"
            width="9"
            height="3.6"
            rx="1.8"
            fill="#ECB22E"
          />
          <rect
            x="10.4"
            y="12.5"
            width="3.6"
            height="9"
            rx="1.8"
            fill="#E01E5A"
          />
        </svg>
      );
    // Figma's mark: five shapes in its five brand colours, the bottom-right one
    // a circle and the rest rounded rectangles.
    case "figma":
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            d="M8.5 2h3.5v6H8.5a3 3 0 0 1 0-6z"
            fill="#F24E1E"
          />
          <path d="M12 2h3.5a3 3 0 0 1 0 6H12V2z" fill="#FF7262" />
          <path d="M12 8h3.5a3 3 0 0 1 0 6H12V8z" fill="#1ABCFE" />
          <path
            d="M8.5 8H12v6H8.5a3 3 0 0 1 0-6z"
            fill="#A259FF"
          />
          <path
            d="M8.5 14H12v3a3 3 0 1 1-3.5-3z"
            fill="#0ACF83"
          />
        </svg>
      );
    case "gitlab":
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            fill="#FC6D26"
            d="M12 21.5 5 11.6l1.7-5.3a.5.5 0 0 1 .95 0L9.5 11.6h5l1.85-5.3a.5.5 0 0 1 .95 0L19 11.6 12 21.5z"
          />
          <path fill="#E24329" d="M12 21.5 9.5 11.6h5L12 21.5z" />
        </svg>
      );
    default:
      return null;
  }
}
