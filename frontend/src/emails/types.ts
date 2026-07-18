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
  preview?: string | null;
  body?: string | null;
  created_at: string;
  has_attachments?: boolean;
  is_read?: boolean;
  attachments_checked?: boolean;
  attachments?: EmailAttachment[];
  zoom_join_url?: string | null;
  // Populated only when the row comes from a shared account; personal-inbox
  // rows leave these undefined.
  is_shared?: boolean;
  shared_label?: string | null;
  inbox_status?: "open" | "pending" | "closed" | null;
  inbox_assignee_id?: number | null;
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
  | "signal"
  | "noise";

export const STUB_EMAIL_FOLDERS: ReadonlyArray<EmailFolder> = [];
