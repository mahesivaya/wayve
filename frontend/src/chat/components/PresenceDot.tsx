import type { PresenceInfo } from "../hooks/usePresence";

type Props = {
  presence: PresenceInfo | undefined;
};

// Human labels + dot modifier per status. Offline always wins (gray), so status
// only tints the dot while the user actually holds a chat socket.
const STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: "Active", cls: "online" },
  dnd: { label: "Do Not Disturb", cls: "dnd" },
  away: { label: "Away", cls: "away" },
};

/**
 * Must be rendered inside a `position: relative` container to pin to the avatar's
 * corner. Draws nothing until presence is known, so a row doesn't flash "offline"
 * before the first snapshot lands.
 */
export default function PresenceDot({ presence }: Props) {
  if (!presence) return null;
  const meta = STATUS_META[presence.status] ?? STATUS_META.active;
  // Offline overrides the status color entirely.
  const cls = presence.online ? meta.cls : "offline";
  const label = presence.online ? meta.label : "Offline";
  return (
    <span
      className={`presence-dot ${cls}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
