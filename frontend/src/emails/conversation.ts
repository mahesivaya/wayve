import type { EmailItem } from "./types";

// A list row stands for a whole conversation, represented by its newest
// message, so its `id` changes when a new reply arrives. Anything that tracks
// rows across refreshes (merge, de-dup, selection) keys on this instead.
// An email with no conversation yet is its own.
export const conversationKey = (email: EmailItem): string =>
  email.thread_id != null ? `t${email.thread_id}` : `e${email.id}`;

// Every message a row covers, for actions that apply to the whole
// conversation (mark read, delete). A plain row covers just itself.
export const conversationMessageIds = (email: EmailItem): number[] =>
  email.message_ids && email.message_ids.length > 0
    ? email.message_ids
    : [email.id];

export const isConversation = (email: EmailItem): boolean =>
  (email.message_count ?? 1) > 1;

// A conversation row is unread while any message in it is, even when its
// newest message (often your own reply) has been read.
export const isUnread = (email: EmailItem): boolean =>
  (email.unread_count ?? 0) > 0 || email.is_read === false;
