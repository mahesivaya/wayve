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

export const getStatusIcon = (status: string) => {
  switch (status) {
    case "sent":
      return "✓";
    case "delivered":
      return "✓✓";
    case "read":
      return "👁";
    default:
      return "";
  }
};

export const getConversationTitle = (conversation: Conversation | null) => {
  if (!conversation) return "Select a conversation";
  return conversation.type === "channel" ? conversation.channel.name : conversation.user.email;
};

export const isChannelAdmin = (
  channel: ChatChannel | null,
  currentUser?: { id: number; email: string } | null,
) =>
  Boolean(
    channel &&
      currentUser &&
      (channel.created_by === currentUser.id ||
        (channel.admin_emails ?? []).some(
          (email) => email.toLowerCase() === currentUser.email.toLowerCase(),
        )),
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
