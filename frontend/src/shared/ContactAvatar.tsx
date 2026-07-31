import { useEffect, useState } from "react";
import { avatarColor, avatarInitial } from "./avatar";

type Props = {
  /** Real profile photo URL (e.g. Google People API), or null/undefined. */
  photoUrl?: string | null;
  /** Name (or address) used for the initial + color fallback. */
  label: string;
  className?: string;
};

/**
 * Avatar for a recipient suggestion: shows the real Google profile photo when
 * one is known, falling back to a colored initial-avatar when there's no photo
 * or the image fails to load (URLs can rotate/expire).
 */
export default function ContactAvatar({ photoUrl, label, className }: Props) {
  const [failed, setFailed] = useState(false);
  // Reset the error state when the row (photo) changes, so a recycled component
  // instance doesn't stay stuck on a previous failure.
  useEffect(() => setFailed(false), [photoUrl]);

  const cls = className ?? "email-mention-avatar";
  if (photoUrl && !failed) {
    return (
      <img
        className={cls}
        src={photoUrl}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className={cls}
      aria-hidden="true"
      style={{ background: avatarColor(label) }}
    >
      {avatarInitial(label)}
    </span>
  );
}
