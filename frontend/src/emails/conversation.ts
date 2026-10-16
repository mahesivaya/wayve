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

// A conversation row is starred while any message in it is, as in Gmail.
export const isStarred = (email: EmailItem): boolean =>
  email.is_starred === true || (email.starred_ids?.length ?? 0) > 0;

// Who a row names, Gmail-style: everyone who wrote in the conversation, your
// own addresses as "me" ("Ayana, me"). Up to three names; a longer list keeps
// the first and the two latest ("Ann … Bob, me"). Each name says whether that
// person has an unread message, which is what Gmail bolds. `label` is the
// plain text, `lead` the first name that isn't you (for the avatar). A row
// without participants (a per-email list) names its sender, as before.
export type SenderName = { name: string; unread: boolean };

export function conversationSenders(
  email: Pick<EmailItem, "sender" | "receiver" | "participants">,
  ownAddresses: Iterable<string>,
  displayName: (value: string | null | undefined) => string
): { names: SenderName[]; gap: boolean; label: string; lead: string } {
  const participants = (email.participants ?? []).filter((p) => p.sender);
  if (participants.length === 0) {
    const name = displayName(email.sender || email.receiver);
    return {
      names: [{ name, unread: false }],
      gap: false,
      label: name,
      lead: name,
    };
  }
  const own = new Set(
    Array.from(ownAddresses, (a) => a.trim().toLowerCase()).filter(Boolean)
  );
  const all: SenderName[] = [];
  for (const participant of participants) {
    const name = own.has(addressOf(participant.sender).toLowerCase())
      ? "me"
      : displayName(participant.sender);
    const seen = all.find((n) => n.name === name);
    if (seen) seen.unread ||= participant.unread;
    else all.push({ name, unread: participant.unread });
  }
  const gap = all.length > 3;
  const names = gap ? [all[0], ...all.slice(-2)] : all;
  const label = gap
    ? `${names[0].name} … ${names
        .slice(1)
        .map((n) => n.name)
        .join(", ")}`
    : names.map((n) => n.name).join(", ");
  return {
    names,
    gap,
    label,
    lead: all.find((n) => n.name !== "me")?.name ?? "me",
  };
}

// "Ada <ada@x.com>" → "ada@x.com"; a bare address is returned trimmed.
function addressOf(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim();
}
