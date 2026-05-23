import type { ChannelId, UserId } from "../types/brand";
import { apiFetch, apiFetchJson } from "./client";

export type ChatUser = {
  id: number;
  email: string;
  public_key?: number[] | null;
};

export type ChatMessage = {
  message_id?: number;
  sender_id: number;
  receiver_id?: number;
  channel_id?: number;
  content: string;
  status: "sent" | "delivered" | "read";
  created_at: string;
  // Threaded channel replies set this to the parent (top-level) message id.
  // Null/undefined = top-level. Threads are channel-only on the wire — the
  // backend rejects DMs with parent_message_id set.
  parent_message_id?: number | null;
  // Server-computed count of replies under a top-level message. Only present
  // on top-level rows returned by the main channel history fetch; replies
  // themselves carry 0.
  reply_count?: number;
};

export type ChatChannel = {
  id: number;
  name: string;
  visibility: "public" | "private";
  created_by: number;
  created_at: string;
  current_user_role?: "admin" | "user";
  is_member: boolean;
  join_status?: "pending";
  member_ids: number[];
  member_emails: string[];
  admin_emails?: string[];
  user_emails?: string[];
  invite_emails?: string[];
  invite_role?: "admin" | "user";
  admin_invite_emails?: string[];
  user_invite_emails?: string[];
  pending_join_requests?: Array<{
    user_id: number;
    email: string;
  }>;
};

export const getChatUsers = async () =>
  apiFetchJson<ChatUser[]>("/api/users/all");

export const getChatMessages = async (userId: number, otherUserId: number) => {
  const params = new URLSearchParams({
    user1: String(userId),
    user2: String(otherUserId),
  });

  return apiFetchJson<ChatMessage[]>(`/api/messages?${params.toString()}`);
};

export const getChatChannels = async () =>
  apiFetchJson<ChatChannel[]>("/api/chat/channels");

export const createChatChannel = async (
  name: string,
  inviteRole: "admin" | "user",
  inviteEmails: string[],
) => {
  const res = await apiFetch("/api/chat/channels", {
    method: "POST",
    body: JSON.stringify({
      name,
      invite_role: inviteRole,
      invite_emails: inviteEmails,
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "Failed to create channel");
  }

  return res.json() as Promise<ChatChannel>;
};

export const updateChatChannelSubject = async (
  channelId: number,
  name: string,
) => {
  const res = await apiFetch(`/api/chat/channels/${channelId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "Failed to update channel subject");
  }
};

export const updateChatChannelVisibility = async (
  channelId: number,
  visibility: "public" | "private",
) => {
  const res = await apiFetch(`/api/chat/channels/${channelId}/visibility`, {
    method: "PATCH",
    body: JSON.stringify({ visibility }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "Failed to update channel visibility");
  }
};

export const joinChatChannel = async (channelId: number) => {
  const res = await apiFetch(`/api/chat/channels/${channelId}/join`, {
    method: "POST",
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "Failed to join channel");
  }

  return res.json() as Promise<{ status: "joined" | "pending" }>;
};

// Brands are applied here because the call takes two ids of different kinds
// positionally — `approveChatChannelJoinRequest(userId, channelId)` would
// otherwise compile. Callers must funnel ids through `asChannelId` / `asUserId`.
export const approveChatChannelJoinRequest = async (
  channelId: ChannelId,
  userId: UserId,
) => {
  const res = await apiFetch(`/api/chat/channels/${channelId}/join-requests/approve`, {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "Failed to approve join request");
  }
};

export const addChatChannelUsers = async (
  channelId: number,
  inviteRole: "admin" | "user",
  inviteEmails: string[],
) => {
  const res = await apiFetch(`/api/chat/channels/${channelId}/members`, {
    method: "POST",
    body: JSON.stringify({
      invite_role: inviteRole,
      invite_emails: inviteEmails,
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "Failed to add channel users");
  }
};

export const removeChatChannelUser = async (
  channelId: number,
  email: string,
) => {
  const res = await apiFetch(`/api/chat/channels/${channelId}/members`, {
    method: "DELETE",
    body: JSON.stringify({ email }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "Failed to delete channel user");
  }
};

export const getChannelMessages = async (channelId: number) => {
  const params = new URLSearchParams({
    channel_id: String(channelId),
  });

  return apiFetchJson<ChatMessage[]>(
    `/api/chat/channel-messages?${params.toString()}`,
  );
};

export const getChannelThread = async (parentMessageId: number) =>
  apiFetchJson<ChatMessage[]>(
    `/api/chat/channel-messages/${parentMessageId}/thread`,
  );
