import type { PresenceInfo } from "../hooks/usePresence";

type Props = {
  presence: PresenceInfo | undefined;
};

/**
 * Must be rendered inside a `position: relative` container to pin to the avatar's
 * corner. Draws nothing until presence is known, so a row doesn't flash "offline"
 * before the first snapshot lands.
 */
export default function PresenceDot({ presence }: Props) {
  if (!presence) return null;
  const online = presence.online;
  return (
    <span
      className={`presence-dot ${online ? "online" : "offline"}`}
      role="img"
      aria-label={online ? "Online" : "Offline"}
      title={online ? "Online" : "Offline"}
    />
  );
}
