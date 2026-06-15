import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { BellIcon, EmailsIcon } from "../icons";
import Avatar from "./Avatar";
import { getApiBase } from "../config/env";
import { getHomeInbox } from "../api/home";
import { getChatConversationSummary, getChatUsers } from "../api/chat";
import { relativeTime } from "../chat/utils";
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
    };

const COLLAPSED_COUNT = 5;
const EXPANDED_COUNT = 10;

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
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<NotifItem[]>([]);
  // Has at least one fetch finished? Drives the "all caught up" vs "loading"
  // empty states.
  const [loadedOnce, setLoadedOnce] = useState(false);

  const total = Math.max(0, emailUnread) + Math.max(0, chatUnread);

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
      setExpanded(false);
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

  const visible = useMemo(
    () => items.slice(0, expanded ? EXPANDED_COUNT : COLLAPSED_COUNT),
    [items, expanded]
  );

  if (!user) return null;

  const go = (path: string) => {
    setOpen(false);
    void navigate(path);
  };

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

          {loading && !loadedOnce ? (
            <div className="notif-empty">Loading…</div>
          ) : items.length === 0 ? (
            <div className="notif-empty">You&apos;re all caught up</div>
          ) : (
            <>
              <ul className="notif-list">
                {visible.map((item) => (
                  <li key={item.key}>
                    <button
                      type="button"
                      className="notif-item"
                      onClick={() =>
                        go(item.kind === "email" ? "/emails" : "/chat")
                      }
                    >
                      <span className="notif-item-icon">
                        {item.kind === "email" ? (
                          <EmailsIcon size={18} />
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
                      <span className="notif-item-time">
                        {relativeTime(item.ts)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              {!expanded && items.length > COLLAPSED_COUNT && (
                <button
                  type="button"
                  className="notif-viewall"
                  onClick={() => setExpanded(true)}
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
