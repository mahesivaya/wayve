import { type EmailAttachment } from "../api/email";

export type EmailAccount = {
  id: number;
  email: string;
  display_name?: string | null;
  unread_count?: number;
  // Shared-inbox surface. `is_shared` lights up the chip in the sidebar;
  // `shared_label` is the friendly name (e.g. "Support"); `is_owner`
  // distinguishes accounts the user connected themselves from ones
  // they're a member of (controls "Disconnect", rename rights, etc.).
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
  // Shared-inbox surface (populated when the row comes from a shared
  // account). All optional — personal-inbox rows leave them undefined.
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
