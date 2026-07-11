import { useCallback, useEffect, useMemo, useState } from "react";
import { getPresence } from "../../api/chat";
import { logger } from "../../utils/logger";

export type PresenceInfo = {
  online: boolean;
  // RFC3339, or null if the user has never held a chat socket.
  lastSeen: string | null;
};

export type PresenceMap = ReadonlyMap<number, PresenceInfo>;

/**
 * Tracks online/offline for a set of users (the chat directory). Seeds from the
 * `/api/chat/presence` snapshot, applies live `presence` WS frames for instant
 * flips on your contacts, and reconciles on a light poll to catch anyone whose
 * change we didn't get pushed (non-contacts, or a missed frame).
 *
 * Returns the current map plus `applyPresenceEvent`, which the chat socket
 * calls when a `{ type: "presence" }` frame arrives.
 */
export function usePresence(userIds: number[]) {
  const [presence, setPresence] = useState<Map<number, PresenceInfo>>(
    () => new Map()
  );

  // Depend on the id *set*, not the array identity, so the fetch effect doesn't
  // re-run on every render just because a new array was passed.
  const idsKey = useMemo(
    () => [...new Set(userIds)].sort((a, b) => a - b).join(","),
    [userIds]
  );

  const refresh = useCallback(async () => {
    const ids = idsKey ? idsKey.split(",").map(Number) : [];
    if (ids.length === 0) return;
    try {
      const entries = await getPresence(ids);
      setPresence(() => {
        const next = new Map<number, PresenceInfo>();
        for (const e of entries) {
          next.set(e.user_id, { online: e.online, lastSeen: e.last_seen });
        }
        return next;
      });
    } catch (err) {
      logger.error("presence snapshot failed", err);
    }
  }, [idsKey]);

  useEffect(() => {
    void refresh();
    // Reconcile fallback; WS frames keep contacts snappier between polls.
    const id = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const applyPresenceEvent = useCallback(
    (userId: number, online: boolean, lastSeen: string | null) => {
      setPresence((prev) => {
        const next = new Map(prev);
        next.set(userId, { online, lastSeen });
        return next;
      });
    },
    []
  );

  return { presence: presence as PresenceMap, applyPresenceEvent };
}
