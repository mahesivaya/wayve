import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { BellIcon, EmailsIcon, DriveIcon } from "../icons";
import Avatar from "./Avatar";
import { getApiBase } from "../config/env";
import { getHomeInbox } from "../api/home";
import { getChatConversationSummary, getChatUsers } from "../api/chat";
import { relativeTime } from "../chat/utils";
import { useStorageStatus } from "./useStorageStatus";
import "./notificationBell.css";

type NotifItem =
  | {
      kind: "email";
      key: string;
      title: string;
      subtitle: string;
      ts: string | null;
    }
  | {
      kind: "chat";
      key: string;
      userId: number;
      email: string;
      title: string;
      ts: string | null;
    }
  | {
      kind: "storage";
      key: string;
      title: string;
      critical: boolean;
      ts: null;
    };

type NotificationBellProps = {
  emailUnread: number;
  chatUnread: number;
};

/**
 * Header bell that surfaces unread emails + chat messages in one place. The
 * badge count is driven by the same two hooks that feed the sidebar badges
 * (passed in as props, so they stay in lock-step). The item list is fetched
 * lazily on first open, reusing the home-inbox preview, the chat conversation
 * summary, and the chat user directory (`/api/users/all`) for id→email — the
 * exact path the Chat page itself uses, so no backend change is needed.
 */
export default function NotificationBell({
  emailUnread,
  chatUnread,
}: NotificationBellProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<NotifItem[]>([]);
  // Has at least one fetch finished? Drives the "all caught up" vs "loading"
  // empty states.
  const [loadedOnce, setLoadedOnce] = useState(false);

  // Storage/memory limit alert — shared with the top StorageLimitBanner, and
  // already gated to the right audience (personal accounts + org owners only).
  const { level: storageLevel, pct: storagePct } = useStorageStatus();
  const storageItem: NotifItem | null =
    storageLevel === "none"
      ? null
      : {
          kind: "storage",
          key: "storage-limit",
          critical: storageLevel === "critical",
          ts: null,
          title:
            storageLevel === "critical"
              ? "Storage full — uploads blocked. Free space or upgrade."
              : `You're almost out of space — ${Math.min(
                  999,
                  Math.round((storagePct ?? 0) * 100)
                )}% used.`,
        };

  const total =
    Math.max(0, emailUnread) + Math.max(0, chatUnread) + (storageItem ? 1 : 0);

  // Lazy load: fetch the item lists whenever the panel opens. Failures are
  // non-fatal — the badge keeps working and the panel just shows its empty
  // state. A guard token discards a stale response if the panel re-opens.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    // Defer to a macrotask so the effect body doesn't synchronously call
    // setState (React 19 "set-state-in-effect" rule) — same pattern as Tasks.
    const timer = window.setTimeout(() => {
      setLoading(true);
      void (async () => {
        try {
          const [inbox, chat, chatUsers] = await Promise.all([
            getHomeInbox().catch(() => ({ unread_count: 0, preview: [] })),
            getChatConversationSummary().catch(() => ({
              total_unread: 0,
              conversations: [],
            })),
            getChatUsers().catch(() => []),
          ]);
          if (!alive) return;

          const emailById = new Map<number, string>(
            chatUsers.map((u) => [u.id, u.email])
          );

          const emailItems: NotifItem[] = inbox.preview.map((e) => ({
            kind: "email",
            key: `e${e.id}`,
            title: e.subject?.trim() || "(no subject)",
            subtitle: e.sender?.trim() || "Unknown sender",
            ts: e.created_at,
          }));

          const chatItems: NotifItem[] = chat.conversations
            .filter((c) => c.unread_count > 0)
            .map((c) => {
              const email = emailById.get(c.user_id) || "someone";
              return {
                kind: "chat",
                key: `c${c.user_id}`,
                userId: c.user_id,
                email,
                title: `${c.unread_count} message${
                  c.unread_count > 1 ? "s" : ""
                } from ${email}`,
                ts: c.last_message_at,
              };
            });

          const merged = [...emailItems, ...chatItems].sort(
            (a, b) =>
              new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime()
          );
          setItems(merged);
          setLoadedOnce(true);
        } finally {
          if (alive) setLoading(false);
        }
      })();
    }, 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // Re-run on each open so reopening refreshes the list.
  }, [open]);

  // Close on outside click + Escape, only while open (mirrors ProfileMenu).
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (
        wrapRef.current &&
        event.target instanceof Node &&
        !wrapRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;

  const go = (path: string) => {
    setOpen(false);
    void navigate(path);
  };

  // Storage alert pinned to the top, ahead of message notifications. Shown even
  // while the email/chat lists are still loading.
  const displayItems: NotifItem[] = storageItem
    ? [storageItem, ...items]
    : items;

  return (
    <div className="notif-bell" ref={wrapRef}>
      <button
        type="button"
        className="notif-bell-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={
          total > 0 ? `${total} unread notifications` : "Notifications"
        }
        title="Notifications"
      >
        <BellIcon size={20} />
        {total > 0 && (
          <span className="notif-badge">{total > 99 ? "99+" : total}</span>
        )}
      </button>

      {open && (
        <div className="notif-panel" role="menu">
          <div className="notif-head">
            <span className="notif-head-title">Notifications</span>
            {total > 0 && <span className="notif-head-count">{total}</span>}
          </div>

          {displayItems.length === 0 ? (
            loading && !loadedOnce ? (
              <div className="notif-empty">Loading…</div>
            ) : (
              <div className="notif-empty">You&apos;re all caught up</div>
            )
          ) : (
            <>
              <ul className="notif-list">
                {displayItems.map((item) => (
                  <li key={item.key}>
                    <button
                      type="button"
                      className={`notif-item${
                        item.kind === "storage" ? " notif-item-storage" : ""
                      }${
                        item.kind === "storage" && item.critical
                          ? " notif-item-critical"
                          : ""
                      }`}
                      onClick={() => {
                        if (item.kind === "storage") go("/billing");
                        else go(item.kind === "email" ? "/emails" : "/chat");
                      }}
                    >
                      <span className="notif-item-icon">
                        {item.kind === "email" ? (
                          <EmailsIcon size={18} />
                        ) : item.kind === "storage" ? (
                          <DriveIcon size={18} />
                        ) : (
                          <Avatar
                            name={item.email}
                            src={`${getApiBase()}/api/users/${item.userId}/avatar`}
                            size={26}
                          />
                        )}
                      </span>
                      <span className="notif-item-body">
                        <span className="notif-item-title">{item.title}</span>
                        {item.kind === "email" && (
                          <span className="notif-item-sub">
                            {item.subtitle}
                          </span>
                        )}
                      </span>
                      {item.kind !== "storage" && (
                        <span className="notif-item-time">
                          {relativeTime(item.ts)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>

              {/* The list scrolls within the panel; this jumps to the full
                  inbox for the complete view. Only when there are message
                  notifications (the storage alert links to /billing itself). */}
              {items.length > 0 && (
                <button
                  type="button"
                  className="notif-viewall"
                  onClick={() => go("/emails")}
                >
                  View all
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
