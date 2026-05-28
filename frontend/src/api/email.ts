import { apiFetch, apiFetchJson } from "./client";

// Mirrors `EmailFolder` in `../emails/types.ts`. Kept in sync by convention
// rather than imported — this module is the lowest layer of the API client
// and we don't want it to depend on the feature folder. The backend's
// `routes/email.rs::get_emails` ignores unknown folder values today
// (returns all), so the stub folders are safe to pass over the wire until
// the sync worker starts ingesting Gmail labels / Outlook categories.
export type EmailFolder =
  | "inbox"
  | "sent"
  | "important"
  | "updates"
  | "spam"
  | "drafts"
  | "social";

export type EmailListParams = {
  folder: EmailFolder;
  accountId?: number | null;
  query?: string;
  before?: number;
  beforeId?: number;
};

export type EmailListResult<T = unknown> = {
  emails: T[];
  hasMore: boolean;
};

export type SendEmailPayload = {
  account_id: number;
  to: string;
  subject: string;
  body: string;
};

export type EmailAttachment = {
  id: number;
  email_id: number;
  filename: string;
  mime_type?: string | null;
  size?: number | null;
  created_at?: string | null;
  subject?: string | null;
  sender?: string | null;
  receiver?: string | null;
};

const emailListPath = ({
  folder,
  accountId,
  query,
  before,
  beforeId,
}: EmailListParams) => {
  const params = new URLSearchParams({ folder });

  if (accountId !== null && accountId !== undefined) {
    params.set("account_id", String(accountId));
  }

  if (query) {
    params.set("q", query);
  }

  if (before !== undefined) {
    params.set("before", String(before));
  }

  if (beforeId !== undefined) {
    params.set("before_id", String(beforeId));
  }

  return `/api/emails?${params.toString()}`;
};

export const getAccounts = async <T = unknown>() =>
  apiFetchJson<T[]>("/api/accounts");

// Total unread email count across all of the user's accounts. Backed by the
// `idx_emails_unread` partial index, so this is cheap even on a huge inbox.
// Powers the sidebar nav badge (and the "All Accounts" filter badge) without
// loading the full inbox to count locally.
export const getEmailsUnreadCount = async (): Promise<number> => {
  const data = await apiFetchJson<{ count: number }>("/api/emails/unread-count");
  return data.count ?? 0;
};

export const deleteAccount = async (id: number) => {
  await apiFetch(`/api/accounts/${id}`, {
    method: "DELETE",
  });
};

export const updateAccountDisplayName = async (
  id: number,
  displayName: string | null
) => {
  await apiFetch(`/api/accounts/${id}/display-name`, {
    method: "PUT",
    body: JSON.stringify({ display_name: displayName }),
  });
};

export const getGmailConnectUrl = async () => {
  const data = await apiFetchJson<{ url: string }>("/api/gmail/connect-url", {
    method: "POST",
  });
  return data.url;
};

export const getOutlookConnectUrl = async () => {
  const data = await apiFetchJson<{ url: string }>("/api/outlook/connect-url", {
    method: "POST",
  });
  return data.url;
};

// Yahoo doesn't use OAuth — the caller posts the email + app password
// directly and the backend verifies via IMAP LOGIN before persisting the
// credentials (encrypted at rest). Returns the new email_accounts row id
// on success; throws with the backend's user-facing message on failure.
export const connectYahoo = async (
  email: string,
  appPassword: string,
): Promise<{ id: number; email: string; provider: string }> => {
  return apiFetchJson<{ id: number; email: string; provider: string }>(
    "/api/yahoo/connect",
    {
      method: "POST",
      body: JSON.stringify({ email, app_password: appPassword }),
    },
  );
};

// Persist that the user has opened this email. The frontend flips `is_read`
// optimistically; this call is what makes the change survive a page refresh.
// Fire-and-forget — the caller logs failures but doesn't roll the UI back.
export const markEmailRead = async (emailId: number): Promise<void> => {
  await apiFetchJson(`/api/emails/${emailId}/read`, { method: "POST" });
  // Poke any mounted unread-count badges (Layout sidebar, "All Accounts"
  // filter) so they refresh from /api/emails/unread-count instead of waiting
  // for the 60s poll. Listener lives in useEmailsUnreadCount.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("rwayve:emails-unread-changed"));
  }
};

// Maps an arbitrary email address to the OAuth provider key the backend
// supports (`"gmail"` or `"outlook"` today). Throws on unsupported domains —
// the backend has logged the attempt at WARN level (target: "email").
// See [provider_lookup.rs](../../../backend/src/email/provider_lookup.rs).
export const lookupEmailProvider = async (email: string): Promise<string> => {
  const data = await apiFetchJson<{ provider: string }>(
    "/api/email/provider-lookup",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    },
  );
  return data.provider;
};

export const getEmails = async <T = unknown>(
  params: EmailListParams
): Promise<EmailListResult<T>> => {
  const res = await apiFetch(emailListPath(params));
  const emails = (await res.json()) as T[];

  return {
    emails,
    hasMore: res.headers.get("x-has-more") === "true",
  };
};

export const getEmail = async <T = unknown>(id: number) =>
  apiFetchJson<T>(`/api/emails/${id}`);

export const deleteEmail = async (id: number) => {
  await apiFetch(`/api/emails/${id}`, {
    method: "DELETE",
  });
};

export const getEmailBody = async (id: number) =>
  apiFetchJson<{ body?: string }>(`/api/emails/${id}/body`);

export const getEmailAttachments = async (emailId: number) =>
  apiFetchJson<EmailAttachment[]>(`/api/emails/${emailId}/attachments`);

export const getAllEmailAttachments = async () =>
  apiFetchJson<EmailAttachment[]>("/api/emails/attachments");

/**
 * Download an email attachment. If `userId` is provided AND the bytes
 * start with the WV1 envelope magic (i.e. the attachment was originally
 * a Wayve-encrypted file forwarded via email), decrypt client-side.
 *
 * Important limitation: outbound email attachments from Wayve to
 * non-Wayve recipients are NOT E2E-encrypted — they go through the
 * standard Gmail/Outlook SMTP path in plaintext, because the recipient's
 * mail client can't decrypt our envelope format. End-to-end for
 * attachments is only achievable inside the Wayve <-> Wayve loop today.
 */
export const downloadEmailAttachment = async (
  attachment: EmailAttachment,
  userId: number | null = null,
) => {
  const res = await apiFetch(`/api/email-attachments/${attachment.id}/download`);
  const ct = res.headers.get("content-type") ?? "application/octet-stream";
  const raw = new Uint8Array(await res.arrayBuffer());

  let blob: Blob;
  if (userId != null) {
    const { looksLikeEnvelope, decryptBlobForSelf } = await import(
      "../crypto/fileEnvelope"
    );
    blob = looksLikeEnvelope(raw)
      ? await decryptBlobForSelf(raw, userId, ct)
      : new Blob([raw], { type: ct });
  } else {
    blob = new Blob([raw], { type: ct });
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.filename || "attachment";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

export const sendEmail = async (payload: SendEmailPayload) => {
  const res = await apiFetch("/api/send", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return res.text();
};

export const getWayveRecipientByEmail = async <T = unknown>(
  email: string,
  token?: string
) =>
  apiFetchJson<T[] | T>(`/api/users?email=${encodeURIComponent(email)}`, {
    headers: token
      ? {
          Authorization: `Bearer ${token}`,
        }
      : undefined,
  });
