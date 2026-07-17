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
  /** "header" is the original top-bar bell; "sidebar" renders a nav row whose
      panel flies out as a fixed-position overlay (the sidebar clips overflow). */
  variant?: "header" | "sidebar";
};

// Counts arrive as props from the same hooks that feed the sidebar badges, so
// the two stay in lock-step. The item list is fetched lazily on first open.
export default function NotificationBell({
  emailUnread,
  chatUnread,
  variant = "header",
}: NotificationBellProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const [open, setOpen] = useState(false);
  // In the sidebar variant the panel is `position: fixed`, anchored to the
  // trigger's on-screen rect so it escapes the sidebar's overflow clipping.
  const [panelPos, setPanelPos] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<NotifItem[]>([]);
  // Distinguishes the "all caught up" empty state from the "loading" one.
  const [loadedOnce, setLoadedOnce] = useState(false);

  // Shared with StorageLimitBanner, which already gates the alert to personal
  // accounts and org owners.
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

  // Fetch on open; failures are non-fatal, leaving the badge working and the
  // panel on its empty state.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    // Deferred to a macrotask so the effect body doesn't synchronously call
    // setState, which React 19 disallows.
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
  }, [open]);

  // Close on outside click and Escape, only while open.
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

  // Storage alert pins to the top and shows even while the lists are loading.
  const displayItems: NotifItem[] = storageItem
    ? [storageItem, ...items]
    : items;

  // For the sidebar variant, capture the trigger rect so the fixed panel flies
  // out to the right of the sidebar, top-aligned to the row (clamped on-screen).
  const toggle = () => {
    setOpen((wasOpen) => {
      const willOpen = !wasOpen;
      if (willOpen && variant === "sidebar" && triggerRef.current) {
        const r = triggerRef.current.getBoundingClientRect();
        const PANEL_W = 340;
        const left = Math.min(r.right + 8, window.innerWidth - PANEL_W - 8);
        const top = Math.min(r.top, window.innerHeight - 120);
        setPanelPos({ left: Math.max(8, left), top: Math.max(8, top) });
      }
      return willOpen;
    });
  };

  const badge =
    total > 0 ? (
      <span className={variant === "sidebar" ? "sidebar-badge" : "notif-badge"}>
        {total > 99 ? "99+" : total}
      </span>
    ) : null;

  const panel = open && (
    <div
      className={`notif-panel${variant === "sidebar" ? " notif-panel--fixed" : ""}`}
      role="menu"
      style={
        variant === "sidebar" && panelPos
          ? { left: panelPos.left, top: panelPos.top }
          : undefined
      }
    >
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
                      <span className="notif-item-sub">{item.subtitle}</span>
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

          {/* Only for message notifications: the storage alert links to
              /billing on its own. */}
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
  );

  if (variant === "sidebar") {
    return (
      <div className="notif-bell notif-bell--sidebar" ref={wrapRef}>
        <button
          type="button"
          ref={triggerRef}
          className="sidebar-link notif-sidebar-trigger"
          onClick={toggle}
          aria-haspopup="true"
          aria-expanded={open}
          title="Notifications"
        >
          <span className="sidebar-icon" aria-hidden="true">
            <BellIcon size={18} />
          </span>
          <span className="sidebar-label">Notifications</span>
          {badge}
        </button>
        {panel}
      </div>
    );
  }

  return (
    <div className="notif-bell" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="notif-bell-btn"
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={
          total > 0 ? `${total} unread notifications` : "Notifications"
        }
        title="Notifications"
      >
        <BellIcon size={20} />
        {badge}
      </button>
      {panel}
    </div>
  );
}
