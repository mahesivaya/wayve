import { type EmailAttachment } from "../api/email";

export type EmailAccount = {
  id: number;
  email: string;
  display_name?: string | null;
  unread_count?: number;
  // `is_owner` distinguishes an account the user connected themselves from one
  // they are merely a member of, which controls rename and disconnect rights.
  is_shared?: boolean;
  shared_label?: string | null;
  is_owner?: boolean;
};

export interface EmailItem {
  id: number;
  account_id?: number | null;
  subject?: string | null;
  sender?: string | null;
  receiver?: string | null;
  // The Cc header, from the detail endpoint. null while not yet known (mail
  // synced before Cc was stored), "" when the message had none.
  cc?: string | null;
  preview?: string | null;
  body?: string | null;
  created_at: string;
  has_attachments?: boolean;
  is_read?: boolean;
  // Starred, as in Gmail. A conversation row is starred while any of its
  // messages is; `starred_ids` names them, so unstarring clears every one.
  is_starred?: boolean;
  starred_ids?: number[];
  attachments_checked?: boolean;
  attachments?: EmailAttachment[];
  zoom_join_url?: string | null;
  // Populated only when the row comes from a shared account; personal-inbox
  // rows leave these undefined.
  is_shared?: boolean;
  shared_label?: string | null;
  inbox_status?: "open" | "pending" | "closed" | null;
  inbox_assignee_id?: number | null;
  // Conversation fields, present when the list is grouped (one row per
  // conversation, represented by its newest message). `message_ids` lists every
  // message in it, newest first, so bulk actions can cover the whole thread.
  thread_id?: number | null;
  message_count?: number | null;
  unread_count?: number | null;
  message_ids?: number[] | null;
  // The unread ones, so marking the conversation read touches only those.
  unread_ids?: number[] | null;
  // Everyone who wrote in the conversation, once each, oldest first, and
  // whether they have an unread message in it.
  participants?: { sender: string; unread: boolean }[] | null;
  _bodyLoading?: boolean;
  _bodyError?: unknown;
}

/** A `WAYVE_SECURE_V1` encrypted email payload (RSA/AES hybrid envelope). */
export interface WayveEncryptedBody {
  type: "wayve_encrypted";
  data: number[];
  key: number[];
  iv: number[];
}

export type { EmailAttachment };

// Inbox and Sent read the `emails` table directly. The rest filter on
// `emails.labels`, which the sync worker fills with Gmail labelIds, Outlook
// categories, and synthetic IMPORTANT / SPAM / DRAFT values, so one filter
// shape works across both providers. `STUB_EMAIL_FOLDERS` is empty but kept:
// adding a name to it re-enables EmailList's coming-soon placeholder branch.
export type EmailFolder =
  | "inbox"
  | "sent"
  | "important"
  // Starred mail (the STARRED label: Gmail's star, Outlook's flag).
  | "starred"
  | "updates"
  | "spam"
  | "drafts"
  | "social"
  | "trash"
  // Virtual folder matched by sender (`notifications@github.com`) on the
  // backend, not a Gmail label.
  | "github"
  // Client-only inbox sub-views shown as chips beside "All" (= inbox). No
  // backend query yet: `useEmailInbox` short-circuits them to an empty list and
  // EmailList renders a "coming soon" placeholder.
  //
  // The intended rule, when these are built: Signal is mail a real person sent
  // you — a human sender with you on To/Cc, and replies in threads you are part
  // of. Noise is bulk and automated: anything carrying a List-Unsubscribe
  // header, no-reply/noreply senders, Gmail's PROMOTIONS/SOCIAL/UPDATES
  // categories, and senders already marked via `markSenderNoise` (which works
  // today and routes to the Noise folder). Deterministic on purpose — no
  // training and no engagement history, so a brand-new important sender lands
  // in Signal on their first message rather than after you have opened enough
  // of their mail.
  | "signal"
  | "noise"
  // All mail: everything except spam, drafts and trash, like Gmail's All Mail.
  // The sidebar's "All mail" row, and what every search reads (see
  // `listFolder`): the inbox leaves out archived and filter-skipped Gmail mail,
  // noise senders and PR notifications, so an in-folder search would miss
  // them — and "Messages from this sender" wants all of that sender's mail.
  | "all";

export const STUB_EMAIL_FOLDERS: ReadonlyArray<EmailFolder> = [];
