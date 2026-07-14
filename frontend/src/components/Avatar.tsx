import { useEffect, useState, type CSSProperties } from "react";
import { getAuthToken } from "../auth/token";
import { PersonIcon } from "../icons";

// The avatar API requires an Authorization header, which a plain <img src> can't
// send, so the image is fetched with the Bearer token and rendered as a blob URL.
// A failed fetch falls back to a neutral silhouette, never a name-derived initial
// or color.

type AvatarProps = {
  /** Retained for API compatibility; used only for accessibility. */
  name?: string | null;
  /** Falsy renders the silhouette only. */
  src?: string | null;
  size?: number;
  className?: string;
};

export default function Avatar({ src, size = 32, className }: AvatarProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  // The blob URL must be revoked on change and unmount or it leaks.
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

  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    flexShrink: 0,
    color: "#fff",
    background: objectUrl ? "transparent" : "#94a3b8",
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
        <PersonIcon size={Math.round(size * 0.6)} />
      )}
    </span>
  );
}
