import type { ChatChannel } from "../api/chat";
import type { ChannelRole, Conversation } from "./types";
import type { PresenceInfo } from "./hooks/usePresence";
import { APP_TIME_ZONE, hourOptions } from "../utils/datetime";

// Empty while presence is unknown, so a row doesn't flash "offline" before the first
// snapshot lands.
export const presenceNameClass = (presence: PresenceInfo | undefined) =>
  presence
    ? presence.online
      ? "conversation-name--online"
      : "conversation-name--offline"
    : "";

export const parseEmails = (value: string) =>
  value
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

// A channel always has fewer than 25 members. The server enforces it (handlers
// plus a database trigger); this mirror only lets the UI say so before a
// request. Keep in step with MAX_CHANNEL_MEMBERS in chat/helpers.rs.
export const MAX_CHANNEL_MEMBERS = 24;
export const CHANNEL_FULL_MESSAGE = `A channel can have at most ${MAX_CHANNEL_MEMBERS} members.`;

// Whether the channel has no seat left. Only the server can tell which invite
// emails belong to registered users (those become members; the rest become
// pending invites), so a partial add near the cap is left to it.
export const isChannelFull = (channel: Pick<ChatChannel, "member_emails">) =>
  channel.member_emails.length >= MAX_CHANNEL_MEMBERS;

export const formatTime = (dateStr: string) => {
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString(undefined, {
        timeZone: APP_TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        ...hourOptions(),
      });
};

// One tick for sent, two for delivered, and two again for read, which the bubble's
// `message-status--read` class recolors.
export const getStatusIcon = (status: string) => {
  switch (status) {
    case "sent":
      return "✓";
    case "delivered":
    case "read":
      return "✓✓";
    default:
      return "";
  }
};

export const getConversationTitle = (conversation: Conversation | null) => {
  if (!conversation) return "Select a conversation";
  return conversation.type === "channel"
    ? conversation.channel.name
    : conversation.user.email;
};

// "just now", "5m", "3h", "2d", "4w", then a short month/day for anything older.
export const relativeTime = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
};

// Whether the current user may manage the channel. Trusts the backend's
// `can_manage` (which covers owner recovery of an admin-less channel); the
// admin-list check is the fallback for payloads without it. Being the creator
// alone doesn't count: a creator can have been demoted.
export const isChannelAdmin = (
  channel: ChatChannel | null,
  currentUser?: { id: number; email: string } | null
) =>
  Boolean(
    channel &&
    currentUser &&
    (channel.can_manage ??
      (channel.admin_emails ?? []).some(
        (email) => email.toLowerCase() === currentUser.email.toLowerCase()
      ))
  );

export const getChannelAdmins = (channel: ChatChannel | null) => [
  ...(channel?.admin_emails ?? []),
  ...(channel?.admin_invite_emails ?? []).map((email) => `${email} invited`),
];

export const getChannelUsers = (channel: ChatChannel | null) => [
  ...(channel?.member_emails ?? []),
  ...(channel?.invite_emails ?? []).map((email) => `${email} invited`),
];

export const roleFromValue = (value: string): ChannelRole =>
  value === "admin" ? "admin" : "user";

// The address that opens a channel. Anyone the channel is open to can follow
// it: a member lands in the channel, anyone else on its join page. The token
// (members are given it) is what opens a personal account's public channel to
// someone outside it; the number alone does not.
export function channelLink(channel: {
  id: number;
  link_token?: string | null;
}): string {
  const base = `${window.location.origin}/chat?c=${channel.id}`;
  return channel.link_token
    ? `${base}&t=${encodeURIComponent(channel.link_token)}`
    : base;
}
