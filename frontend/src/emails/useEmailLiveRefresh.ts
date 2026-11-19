import { useEffect, useRef } from "react";
import { getWsBase } from "../config/env";

// Fired when the server reports that a mailbox just synced, so badges mounted
// outside the mail page refresh with the list instead of on their 60s poll.
export const EMAILS_SYNCED_EVENT = "rwayve:emails-synced";

// A burst of provider pushes (new mail, then its label changes) becomes one
// refresh.
const SETTLE_MS = 400;

let announceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Tell mounted badges and the new-mail alert that a mailbox just synced. For a
 * socket that sees the server's `email:*` frames but isn't the mail page's own:
 * the app-wide chat socket stays open on every page and in a hidden tab, where
 * `useEmailLiveRefresh` below is not running.
 */
export function announceEmailsSynced(): void {
  if (announceTimer !== null) return;
  announceTimer = setTimeout(() => {
    announceTimer = null;
    window.dispatchEvent(new CustomEvent(EMAILS_SYNCED_EVENT));
  }, SETTLE_MS);
}

/**
 * Refreshes mail the moment the server syncs it.
 *
 * A provider push (Gmail `users.watch`) makes the backend sync the mailbox and
 * broadcast an `email:*` frame to the owner's sockets (`gmail_push::sync_on_push`).
 * This listens for that frame on the per-user socket and calls `onChange`, so
 * new mail and read state changed elsewhere show up in a second or two rather
 * than on the next poll. The poll stays as the fallback for mailboxes without
 * push and for a socket that is down.
 *
 * The socket is the chat one, so while it is open the user counts as online
 * and their direct messages as delivered, as on the chat page. It is closed
 * while the tab is hidden, like the poll.
 */
export function useEmailLiveRefresh(
  userId: number | undefined,
  onChange: () => void
) {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!userId) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const notify = () => {
      settleTimer = null;
      if (cancelled) return;
      window.dispatchEvent(new CustomEvent(EMAILS_SYNCED_EVENT));
      onChangeRef.current();
    };
    const notifySoon = () => {
      if (settleTimer === null) settleTimer = setTimeout(notify, SETTLE_MS);
    };

    const connect = () => {
      if (cancelled || ws || document.hidden) return;
      const socket = new WebSocket(`${getWsBase()}/ws/chat`);
      ws = socket;

      socket.onopen = () => {
        // Back after a drop: a sync may have been announced meanwhile.
        if (attempts > 0) notifySoon();
        attempts = 0;
      };

      socket.onmessage = (event) => {
        let type: unknown;
        try {
          type = (JSON.parse(String(event.data)) as { type?: unknown }).type;
        } catch {
          return;
        }
        // Chat frames share this socket; only mail broadcasts matter here.
        if (typeof type === "string" && type.startsWith("email:")) notifySoon();
      };

      socket.onclose = () => {
        // A socket this hook closed itself (hidden tab, unmount) is not `ws`.
        if (ws !== socket) return;
        ws = null;
        if (cancelled || document.hidden) return;
        // Capped exponential backoff with jitter, as the chat socket does.
        attempts += 1;
        const base = Math.min(1000 * 2 ** (attempts - 1), 15000);
        const jitter = base * 0.2 * (Math.random() * 2 - 1);
        reconnectTimer = setTimeout(
          connect,
          Math.max(500, Math.round(base + jitter))
        );
      };
    };

    const disconnect = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const socket = ws;
      ws = null;
      socket?.close();
    };

    const onVisibility = () => {
      if (document.hidden) disconnect();
      else connect();
    };

    connect();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (settleTimer) clearTimeout(settleTimer);
      disconnect();
    };
  }, [userId]);
}
