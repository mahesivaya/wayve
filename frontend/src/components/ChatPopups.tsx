import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import {
  getChannelMessages,
  getChatChannels,
  getChatMessages,
  getChatUsers,
  type ChatChannel,
  type ChatMessage,
  type ChatUser,
} from "../api/chat";
import { useChatViewOpen } from "../chat/chatOpenRegistry";
import MessageText from "../chat/components/MessageText";
import { decryptChatContent, decryptChatMessages } from "../chat/e2ee";
import { messagePreview } from "../chat/messagePreview";
import { useChatSocket } from "../chat/hooks/useChatSocket";
import { useMyStatus } from "../chat/myStatus";
import { encryptTextForSend } from "../chat/outgoing";
import type { Conversation } from "../chat/types";
import { CHAT_UNREAD_CHANGED_EVENT } from "../chat/useChatUnreadCount";
import { logger } from "../utils/logger";
import "./chatPopups.css";

// A collapsed card leaves on its own after this long, unless the pointer is on
// it. An opened conversation stays until closed.
const AUTO_DISMISS_MS = 8_000;
// Older cards drop off once this many are showing.
const MAX_CARDS = 3;
// How much history an opened card shows.
const THREAD_LIMIT = 30;

export type ChatPopup = {
  // `dm:<userId>` or `c:<channelId>`: one card per conversation, so a burst
  // from one person updates their card instead of stacking more.
  key: string;
  title: string;
  // Channel messages: who wrote it. DMs: null (the title is the sender).
  subtitle: string | null;
  // Null when this device can't decrypt the message.
  preview: string | null;
  count: number;
  href: string;
  // Where a reply goes. Null only for the dev demo cards.
  target: Conversation | null;
};

export type ThreadMessage = {
  // The server id, or the client_id of a reply sent from here.
  id: string;
  mine: boolean;
  // Channel messages from others: who wrote it.
  author: string | null;
  text: string;
};

// The one card opened into a mini conversation.
type OpenThread = {
  key: string;
  messages: ThreadMessage[];
  loading: boolean;
  draft: string;
  sending: boolean;
  error: string | null;
};

const keyFor = (msg: ChatMessage) =>
  msg.channel_id != null ? `c:${msg.channel_id}` : `dm:${msg.sender_id}`;

// The app-wide "new message" cards, pinned bottom-right. They show only while no
// Chat view is open (a Chat view owns its own socket and shows messages itself)
// and stay quiet under Do Not Disturb. While active this keeps its own chat
// socket, so messages arrive live on every page. Clicking a card (or Reply)
// opens the conversation right in the card: recent history, live messages, and
// a reply box that sends encrypted the same way as the Chat page.
export default function ChatPopups() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const chatOpen = useChatViewOpen();
  const status = useMyStatus(user?.id);
  const enabled = Boolean(user) && !chatOpen && status !== "dnd";

  const [cards, setCards] = useState<ChatPopup[]>([]);
  const [thread, setThread] = useState<OpenThread | null>(null);
  // Dev demo only: sample cards closed with ×.
  const [demoClosed, setDemoClosed] = useState<string[]>([]);
  const timers = useRef(new Map<string, number>());
  const directory = useRef<ChatUser[] | null>(null);
  const channels = useRef(new Map<number, ChatChannel>());
  // A refused send names its client_id; this finds the thread it was sent from.
  const pendingReplies = useRef(new Map<string, string>());
  // The socket expects a selected conversation; here there never is one, so no
  // message is treated as "being viewed" and no automatic read receipt is sent.
  const noSelection = useRef<Conversation | null>(null);
  // The opened card, readable from socket callbacks.
  const threadKeyRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const dismiss = useCallback((key: string) => {
    const t = timers.current.get(key);
    if (t !== undefined) window.clearTimeout(t);
    timers.current.delete(key);
    setCards((prev) => prev.filter((c) => c.key !== key));
    setDemoClosed((prev) => [...prev, key]);
    setThread((open) => (open?.key === key ? null : open));
  }, []);

  const startTimer = useCallback(
    (key: string) => {
      const prev = timers.current.get(key);
      if (prev !== undefined) window.clearTimeout(prev);
      timers.current.set(
        key,
        window.setTimeout(() => dismiss(key), AUTO_DISMISS_MS)
      );
    },
    [dismiss]
  );

  const pauseTimer = (key: string) => {
    const t = timers.current.get(key);
    if (t !== undefined) window.clearTimeout(t);
    timers.current.delete(key);
  };

  // Hidden while popups are off (chat opened, DND, sign-out). Their timers keep
  // running, so they've expired by the time the user leaves chat again.
  // Dev only (stripped from production builds): `?demoChatPopups` on any page
  // shows sample cards, without timers, to check the look locally.
  const { search } = useLocation();
  const demo =
    import.meta.env.DEV && new URLSearchParams(search).has("demoChatPopups");
  const shown = demo
    ? DEMO_POPUPS.filter((c) => !demoClosed.includes(c.key))
    : enabled
      ? cards
      : [];
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => window.clearTimeout(t));
      pending.clear();
    };
  }, []);

  useEffect(() => {
    threadKeyRef.current = thread?.key ?? null;
  }, [thread?.key]);

  // Keep the newest message in view.
  const messageCount = thread?.messages.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messageCount, thread?.loading]);

  const loadDirectory = async (): Promise<ChatUser[]> => {
    if (!directory.current) {
      try {
        directory.current = await getChatUsers();
      } catch {
        return [];
      }
    }
    return directory.current;
  };

  const findUser = async (id: number): Promise<ChatUser | null> => {
    let found = (await loadDirectory()).find((u) => u.id === id);
    if (!found) {
      // Someone new since the directory loaded: refetch once.
      directory.current = null;
      found = (await loadDirectory()).find((u) => u.id === id);
    }
    return found ?? null;
  };

  const findChannel = async (id: number): Promise<ChatChannel | null> => {
    if (!channels.current.has(id)) {
      try {
        for (const c of await getChatChannels()) channels.current.set(c.id, c);
      } catch {
        // Fall back to a generic title; replies are then unavailable.
      }
    }
    return channels.current.get(id) ?? null;
  };

  const authorOf = (msg: ChatMessage): string | null =>
    msg.channel_id != null
      ? (msg.sender_name ??
        directory.current?.find((u) => u.id === msg.sender_id)?.email ??
        null)
      : null;

  const toThreadMessage = (msg: ChatMessage, myId: number): ThreadMessage => ({
    id: String(msg.message_id ?? msg.client_id ?? crypto.randomUUID()),
    mine: msg.sender_id === myId,
    author: msg.sender_id === myId ? null : authorOf(msg),
    text: msg.content,
  });

  const sendReadReceipt = (peerId: number) => {
    const ws = wsRef.current;
    if (!user || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        sender_id: user.id,
        receiver_id: peerId,
        content: "",
        status: "read",
      })
    );
  };

  const onInbound = (msg: ChatMessage & { type?: string }) => {
    // Only real messages: `conversation_read` and other frames carry a type.
    if (msg.type || !user || msg.sender_id === user.id) return;
    const myId = user.id;
    const key = keyFor(msg);

    // Already open: add it to the conversation, which counts as read.
    if (threadKeyRef.current === key) {
      void decryptChatContent(msg.content, myId).then((text) => {
        setThread((open) =>
          open?.key === key
            ? {
                ...open,
                messages: [
                  ...open.messages,
                  toThreadMessage({ ...msg, content: text }, myId),
                ],
              }
            : open
        );
      });
      if (msg.channel_id == null) sendReadReceipt(msg.sender_id);
      return;
    }

    // Let the sidebar badge catch up right away instead of on its next poll.
    window.dispatchEvent(new Event(CHAT_UNREAD_CHANGED_EVENT));
    void buildPopup(msg, myId).then((card) => {
      if (!card) return;
      setCards((prev) => {
        const existing = prev.find((c) => c.key === card.key);
        const merged = existing ? { ...card, count: existing.count + 1 } : card;
        const rest = prev.filter((c) => c.key !== card.key);
        return [...rest, merged].slice(-MAX_CARDS);
      });
      startTimer(card.key);
    });
  };

  const buildPopup = async (
    msg: ChatMessage,
    myId: number
  ): Promise<ChatPopup | null> => {
    const preview = await messagePreview(msg.content, myId);
    if (msg.channel_id != null) {
      const channel = await findChannel(msg.channel_id);
      const sender =
        msg.sender_name ?? (await findUser(msg.sender_id))?.email ?? null;
      return {
        key: `c:${msg.channel_id}`,
        title: channel ? `#${channel.name}` : "New channel message",
        subtitle: sender,
        preview,
        count: 1,
        href: `/chat?c=${msg.channel_id}`,
        target: channel ? { type: "channel", channel } : null,
      };
    }
    const peer = await findUser(msg.sender_id);
    return {
      key: `dm:${msg.sender_id}`,
      title: peer?.email ?? "New message",
      subtitle: null,
      preview,
      count: 1,
      href: `/chat?dm=${msg.sender_id}`,
      target: peer ? { type: "user", user: peer } : null,
    };
  };

  const onSendFailed = (clientId: string, reason: string) => {
    const key = pendingReplies.current.get(clientId);
    pendingReplies.current.delete(clientId);
    if (!key) return;
    setThread((open) =>
      open?.key === key
        ? {
            ...open,
            messages: open.messages.filter((m) => m.id !== clientId),
            error: reason,
          }
        : open
    );
  };

  const { wsRef } = useChatSocket(
    enabled ? user : null,
    noSelection,
    () => undefined,
    undefined,
    undefined,
    onInbound,
    undefined,
    undefined,
    onSendFailed
  );

  const openThread = async (card: ChatPopup) => {
    pauseTimer(card.key);
    setCards((prev) =>
      prev.map((c) => (c.key === card.key ? { ...c, count: 1 } : c))
    );
    setThread({
      key: card.key,
      messages: [],
      loading: true,
      draft: "",
      sending: false,
      error: null,
    });
    const finish = (messages: ThreadMessage[], error: string | null = null) =>
      setThread((open) =>
        open?.key === card.key
          ? { ...open, messages, loading: false, error }
          : open
      );

    if (!card.target) {
      finish(demo ? demoThread(card) : []);
      return;
    }
    if (!user) return;
    try {
      const target = card.target;
      await loadDirectory();
      // Fetching a DM also marks it read server-side.
      const raw =
        target.type === "user"
          ? await getChatMessages(user.id, target.user.id)
          : await getChannelMessages(target.channel.id);
      const recent = await decryptChatMessages(
        raw.slice(-THREAD_LIMIT),
        user.id
      );
      finish(recent.map((m) => toThreadMessage(m, user.id)));
      window.dispatchEvent(new Event(CHAT_UNREAD_CHANGED_EVENT));
    } catch (err) {
      logger.error("Popup conversation load failed", err);
      finish([], "Couldn't load this conversation.");
    }
  };

  const closeThread = (key: string) => {
    setThread(null);
    startTimer(key);
  };

  const sendReply = async (card: ChatPopup) => {
    if (!thread || thread.key !== card.key || thread.sending) return;
    const text = thread.draft.trim();
    if (!text) return;
    const clientId = crypto.randomUUID();
    const append = () =>
      setThread((open) =>
        open?.key === card.key
          ? {
              ...open,
              draft: "",
              sending: false,
              error: null,
              messages: [
                ...open.messages,
                { id: clientId, mine: true, author: null, text },
              ],
            }
          : open
      );

    // Demo cards have nowhere to send; show the flow anyway.
    if (!card.target) {
      if (demo) append();
      return;
    }
    const ws = wsRef.current;
    if (!user || !ws || ws.readyState !== WebSocket.OPEN) {
      setThread({ ...thread, error: "Not connected. Try again in a moment." });
      return;
    }
    setThread({ ...thread, sending: true, error: null });
    try {
      const target = card.target;
      const content = await encryptTextForSend(
        user,
        target,
        await loadDirectory(),
        text
      );
      // Replying means it was read.
      if (target.type === "user") sendReadReceipt(target.user.id);
      const wire: ChatMessage = {
        sender_id: user.id,
        content,
        status: "sent",
        created_at: new Date().toISOString(),
        client_id: clientId,
        ...(target.type === "user"
          ? { receiver_id: target.user.id }
          : { channel_id: target.channel.id }),
      };
      pendingReplies.current.set(clientId, card.key);
      ws.send(JSON.stringify(wire));
      window.dispatchEvent(new Event(CHAT_UNREAD_CHANGED_EVENT));
      append();
    } catch (err) {
      logger.error("Popup reply failed", err);
      setThread((open) =>
        open?.key === card.key
          ? {
              ...open,
              sending: false,
              error:
                err instanceof Error ? err.message : "Couldn't send the reply.",
            }
          : open
      );
    }
  };

  if (shown.length === 0) return null;

  return (
    <div className="chat-popups" aria-live="polite" aria-label="New messages">
      {shown.map((card) => {
        const open = thread?.key === card.key ? thread : null;
        const canReply = Boolean(card.target) || demo;
        return (
          <div
            key={card.key}
            className={`chat-popup-card${open ? " chat-popup-card--open" : ""}`}
            role={open ? "dialog" : "status"}
            aria-label={open ? `Conversation with ${card.title}` : undefined}
            onMouseEnter={() => pauseTimer(card.key)}
            onMouseLeave={() => {
              if (!open) startTimer(card.key);
            }}
          >
            <div className="chat-popup-main">
              <button
                type="button"
                className="chat-popup-open"
                aria-expanded={Boolean(open)}
                onClick={() => {
                  if (open) closeThread(card.key);
                  else if (canReply) void openThread(card);
                  else {
                    dismiss(card.key);
                    void navigate(card.href);
                  }
                }}
              >
                <span className="chat-popup-avatar" aria-hidden="true">
                  {card.title.replace(/^#/, "").charAt(0).toUpperCase() || "?"}
                </span>
                <span className="chat-popup-body">
                  <span className="chat-popup-title">
                    {card.title}
                    {!open && card.count > 1 && (
                      <span className="chat-popup-count">{card.count} new</span>
                    )}
                  </span>
                  {card.subtitle && !open && (
                    <span className="chat-popup-subtitle">{card.subtitle}</span>
                  )}
                  {!open && (
                    <span className="chat-popup-preview">
                      {card.preview ?? "New message"}
                    </span>
                  )}
                </span>
              </button>
              <button
                type="button"
                className="chat-popup-icon-btn"
                aria-label={`Open ${card.title} in Chat`}
                data-tooltip="Open in Chat"
                onClick={() => {
                  dismiss(card.key);
                  void navigate(card.href);
                }}
              >
                ↗
              </button>
              <button
                type="button"
                className="chat-popup-icon-btn"
                aria-label={`Dismiss message from ${card.title}`}
                onClick={() => dismiss(card.key)}
              >
                ×
              </button>
            </div>

            {open ? (
              <>
                <div className="chat-popup-thread" ref={listRef}>
                  {open.loading ? (
                    <p className="chat-popup-thread-note">Loading…</p>
                  ) : open.messages.length === 0 ? (
                    <p className="chat-popup-thread-note">No messages yet.</p>
                  ) : (
                    open.messages.map((m) => (
                      <div
                        key={m.id}
                        className={`chat-popup-bubble${m.mine ? " chat-popup-bubble--mine" : ""}`}
                      >
                        {m.author && (
                          <span className="chat-popup-bubble-author">
                            {m.author}
                          </span>
                        )}
                        <span className="chat-popup-bubble-text">
                          <MessageText text={m.text} />
                        </span>
                      </div>
                    ))
                  )}
                </div>
                <form
                  className="chat-popup-reply"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void sendReply(card);
                  }}
                >
                  <input
                    className="chat-popup-reply-input"
                    value={open.draft}
                    autoFocus
                    placeholder="Reply…"
                    aria-label={`Reply to ${card.title}`}
                    disabled={open.sending}
                    onChange={(e) =>
                      setThread({ ...open, draft: e.target.value, error: null })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Escape") closeThread(card.key);
                    }}
                  />
                  <button
                    type="submit"
                    className="chat-popup-send"
                    disabled={open.sending || !open.draft.trim()}
                  >
                    {open.sending ? "Sending…" : "Send"}
                  </button>
                  {open.error && (
                    <p className="chat-popup-error" role="alert">
                      {open.error}
                    </p>
                  )}
                </form>
              </>
            ) : (
              canReply && (
                <div className="chat-popup-actions">
                  <button
                    type="button"
                    className="chat-popup-reply-btn"
                    onClick={() => void openThread(card)}
                  >
                    Reply
                  </button>
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

// Dev demo: a short back-and-forth ending on the card's message.
function demoThread(card: ChatPopup): ThreadMessage[] {
  const author = card.subtitle;
  return [
    {
      id: "d1",
      mine: false,
      author,
      text: "Morning! Quick one when you're free.",
    },
    { id: "d2", mine: true, author: null, text: "Sure, what's up?" },
    {
      id: "d3",
      mine: false,
      author,
      text: card.preview ?? "New message",
    },
  ];
}

const DEMO_POPUPS: ChatPopup[] = [
  {
    key: "demo:dm1",
    title: "ana@example.com",
    subtitle: null,
    preview: "Hey! Are we still on for the design review at 3?",
    count: 1,
    href: "/chat",
    target: null,
  },
  {
    key: "demo:dm2",
    title: "raj@example.com",
    subtitle: null,
    preview:
      "Pushed the fix for the dimmed ride rows. Can you take a look before I open the PR? It touches the iOS startup refresh too, so worth a quick check.",
    count: 3,
    href: "/chat",
    target: null,
  },
  {
    key: "demo:channel",
    title: "#engineering",
    subtitle: "Karri",
    preview: "📎 2 attachments",
    count: 1,
    href: "/chat",
    target: null,
  },
];
