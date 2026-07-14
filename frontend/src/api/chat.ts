import type { ChannelId, UserId } from "../types/brand";
import { apiFetch, apiFetchJson } from "./client";
import { getAuthToken } from "../auth/token";
import { getApiBase } from "../config/env";

// `body` is the ciphertext (e2e mode) or the raw file (server mode); `e2e` tells
// the backend which it is. Returns the row id to put in the message envelope and
// the WS frame's `attachment_ids`.
export async function uploadChatAttachment(opts: {
  body: Blob;
  filename: string;
  mime: string;
  e2e: boolean;
}): Promise<{
  id: number;
  filename: string;
  mime_type: string | null;
  size: number;
  e2e: boolean;
}> {
  const form = new FormData();
  form.append("e2e", String(opts.e2e));
  form.append(
    "file",
    new File([opts.body], opts.filename, { type: opts.mime })
  );
  const token = getAuthToken();
  const res = await fetch(`${getApiBase()}/api/chat/attachments`, {
    method: "POST",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) {
    let message = "Attachment upload failed";
    try {
      const data = await res.clone().json();
      message = data?.message || data?.error || message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  return res.json();
}

// Returns client-ciphertext when e2e, else the plaintext file. Raw fetch so the
// body stays binary; never triggers session-expiry handling.
export async function downloadChatAttachment(id: number): Promise<ArrayBuffer> {
  const token = getAuthToken();
  const res = await fetch(
    `${getApiBase()}/api/chat/attachments/${id}/download`,
    {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }
  );
  if (!res.ok) {
    throw new Error(`Attachment download failed (${res.status})`);
  }
  return res.arrayBuffer();
}

export type ChatUser = {
  id: number;
  email: string;
  public_key?: number[] | null;
};

// Reactions are NOT end-to-end encrypted (message content is): they are
// aggregated server-side, so the server sees who reacted with what.
export type ReactionGroup = {
  emoji: string;
  user_ids: number[];
};

export type ChatMessage = {
  message_id?: number;
  sender_id: number;
  // Returned on channel messages only. Absent on DMs, where the peer is known.
  sender_name?: string | null;
  receiver_id?: number;
  channel_id?: number;
  content: string;
  status: "sent" | "delivered" | "read";
  created_at: string;
  // Threaded channel replies set this to the parent's message id; null/undefined
  // is top-level. Channel-only on the wire — the backend rejects a DM that sets it.
  parent_message_id?: number | null;
  // Server-computed. Only present on top-level rows from the channel history
  // fetch; replies themselves carry 0.
  reply_count?: number;
  // Sender-generated correlation token, echoed back in the broadcast so the
  // sender's UI can match the server-assigned `message_id` to its optimistic copy.
  client_id?: string | null;
  // Sent with the WS frame to link uploads to this message; absent on history rows.
  attachment_ids?: number[];
  // Local-only, populated after decryption and never sent on the wire: descriptors
  // parsed from the envelope, the raw envelope (to lazily unwrap the AES key for
  // e2e attachment download), and the local files backing an optimistic bubble.
  attachments?: ChatAttachmentMeta[];
  _envelope?: string;
  _localFiles?: File[];
  // Returned by the history fetches and replaced wholesale by each
  // `reaction_updated` WS frame.
  reactions?: ReactionGroup[];
};

// Reacting with an emoji you've already used removes it — one frame, both
// directions.
export function reactionFrame(
  messageId: number,
  isChannel: boolean,
  emoji: string
): string {
  return JSON.stringify({
    type: "react",
    message_id: messageId,
    is_channel: isChannel,
    emoji,
  });
}

// Mirrors the descriptor carried inside the envelope.
export type ChatAttachmentMeta = {
  id: number;
  name: string;
  mime: string | null;
  size: number;
  iv?: number[];
};

export type ChatChannel = {
  id: number;
  name: string;
  visibility: "public" | "private";
  created_by: number;
  created_at: string;
  // Null when the channel has no messages yet. Drives the sidebar "Recent" group.
  last_message_at?: string | null;
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

// `online` is the realtime signal (a live chat socket somewhere); `last_seen`
// (RFC3339, null if never connected) is shown when they're offline. Live changes
// also arrive over the chat socket as `{ type: "presence" }` frames — this
// endpoint seeds the initial state and reconciles on a light poll.
export type UserPresence = {
  user_id: number;
  online: boolean;
  last_seen: string | null;
};

export const getPresence = async (ids: number[]): Promise<UserPresence[]> => {
  if (ids.length === 0) return [];
  const params = new URLSearchParams({ ids: ids.join(",") });
  const data = await apiFetchJson<{ presence: UserPresence[] }>(
    `/api/chat/presence?${params.toString()}`
  );
  return data.presence;
};

// Counts and timestamps only — message content stays E2E-encrypted and is never
// returned here.
export type DmConversationSummary = {
  user_id: number;
  unread_count: number;
  last_message_at: string | null; // RFC3339
};
export type ChatConversationSummary = {
  total_unread: number;
  conversations: DmConversationSummary[];
};
// Three independent consumers poll this (the unread badge, the Chat page list,
// and the notification bell), so concurrent callers share one in-flight request
// and a result newer than SUMMARY_TTL_MS is reused. Real-time updates arrive over
// the chat websocket, so a few seconds of staleness here is harmless.
const SUMMARY_TTL_MS = 5000;
let summaryCache: { at: number; data: ChatConversationSummary } | null = null;
let summaryInFlight: Promise<ChatConversationSummary> | null = null;

export const getChatConversationSummary =
  async (): Promise<ChatConversationSummary> => {
    if (summaryCache && Date.now() - summaryCache.at < SUMMARY_TTL_MS) {
      return summaryCache.data;
    }
    if (summaryInFlight) return summaryInFlight;
    summaryInFlight = apiFetchJson<ChatConversationSummary>(
      "/api/chat/conversations"
    )
      .then((data) => {
        summaryCache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        summaryInFlight = null;
      });
    return summaryInFlight;
  };

export const getChatMessages = async (
  userId: number,
  otherUserId: number,
  // Reconnect resync: when set, the server returns only messages newer than this
  // id, so the client backfills exactly what it missed.
  sinceId?: number
) => {
  const params = new URLSearchParams({
    user1: String(userId),
    user2: String(otherUserId),
  });
  if (sinceId != null) params.set("since_id", String(sinceId));

  return apiFetchJson<ChatMessage[]>(
    `/api/chat/direct-messages?${params.toString()}`
  );
};

export const getChatChannels = async () =>
  apiFetchJson<ChatChannel[]>("/api/chat/channels");

export const createChatChannel = async (
  name: string,
  inviteRole: "admin" | "user",
  inviteEmails: string[],
  visibility: "public" | "private"
) => {
  const res = await apiFetch("/api/chat/channels", {
    method: "POST",
    body: JSON.stringify({
      name,
      invite_role: inviteRole,
      invite_emails: inviteEmails,
      visibility,
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
  name: string
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
  visibility: "public" | "private"
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

// Branded ids because the call takes two ids of different kinds positionally —
// `approveChatChannelJoinRequest(userId, channelId)` would otherwise compile.
// Callers must funnel ids through `asChannelId` / `asUserId`.
export const approveChatChannelJoinRequest = async (
  channelId: ChannelId,
  userId: UserId
) => {
  const res = await apiFetch(
    `/api/chat/channels/${channelId}/join-requests/approve`,
    {
      method: "POST",
      body: JSON.stringify({ user_id: userId }),
    }
  );

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "Failed to approve join request");
  }
};

export const addChatChannelUsers = async (
  channelId: number,
  inviteRole: "admin" | "user",
  inviteEmails: string[]
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
  email: string
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

export const getChannelMessages = async (
  channelId: number,
  // Reconnect resync — see getChatMessages.
  sinceId?: number
) => {
  const params = new URLSearchParams({
    channel_id: String(channelId),
  });
  if (sinceId != null) params.set("since_id", String(sinceId));

  return apiFetchJson<ChatMessage[]>(
    `/api/chat/channel-messages?${params.toString()}`
  );
};

export const getChannelThread = async (parentMessageId: number) =>
  apiFetchJson<ChatMessage[]>(
    `/api/chat/channel-messages/${parentMessageId}/thread`
  );
