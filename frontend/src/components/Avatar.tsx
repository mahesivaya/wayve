import { useEffect, useState, type CSSProperties } from "react";
import { getAuthToken } from "../auth/token";

// The single source of truth for rendering a user's avatar anywhere in the app.
// Pass a `src` (the /api/users/{id}/avatar URL) and a `name` (email or display
// name). The image is fetched WITH the Bearer token and rendered as a blob URL
// — a plain <img src> can't send the Authorization header this API needs, so it
// would 401. If the fetch fails (no upload / 404 / error), it falls back to a
// colored initial derived from `name`. Any page that wants real profile photos
// just renders <Avatar/>; no per-page image logic.

const PALETTE = [
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#059669",
  "#d97706",
  "#dc2626",
  "#0891b2",
  "#4f46e5",
];

function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

type AvatarProps = {
  /** Email or display name — drives the fallback initial and its color. */
  name?: string | null;
  /** Image URL (e.g. /api/users/{id}/avatar). Falsy → initial only. */
  src?: string | null;
  /** Pixel diameter. Default 32. */
  size?: number;
  /** Extra class on the root (e.g. "profile-avatar" for the header hover). */
  className?: string;
};

export default function Avatar({
  name,
  src,
  size = 32,
  className,
}: AvatarProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  // Fetch the image with the Bearer token, expose it as a blob URL, and revoke
  // it on change/unmount. On any failure we leave objectUrl null → initial.
  useEffect(() => {
    if (!src) {
      setObjectUrl(null);
      return;
    }
    let cancelled = false;
    let created: string | null = null;
    setObjectUrl(null);
    void (async () => {
      try {
        const token = getAuthToken();
        const res = await fetch(src, {
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      } catch {
        if (!cancelled) setObjectUrl(null);
      }
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [src]);

  const seed = name?.trim() || "?";
  const initial = seed.charAt(0).toUpperCase();

  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    flexShrink: 0,
    fontSize: Math.round(size * 0.45),
    fontWeight: 600,
    color: "#fff",
    background: objectUrl ? "transparent" : colorFor(seed),
    userSelect: "none",
  };

  return (
    <span className={className} style={style} aria-hidden="true">
      {objectUrl ? (
        <img
          src={objectUrl}
          alt=""
          width={size}
          height={size}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        initial
      )}
    </span>
  );
}
