import type { ChatChannel } from "../api/chat";
import type { ChannelRole, Conversation } from "./types";
import { APP_TIME_ZONE } from "../utils/datetime";

export const parseEmails = (value: string) =>
  value
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

export const formatTime = (dateStr: string) => {
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("en-US", {
        timeZone: APP_TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
      });
};

// WhatsApp-style ticks: single check when sent, double check once
// delivered, double check (colored blue by the bubble's `message-status--read`
// class) once read.
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

// Compact relative time for conversation rows: "just now", "5m", "3h", "2d",
// "4w", then a short month/day for anything older. Empty string for no time.
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

export const isChannelAdmin = (
  channel: ChatChannel | null,
  currentUser?: { id: number; email: string } | null
) =>
  Boolean(
    channel &&
    currentUser &&
    (channel.created_by === currentUser.id ||
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
