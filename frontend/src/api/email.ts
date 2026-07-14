import { apiFetch, apiFetchJson } from "./client";

// Duplicates `EmailFolder` in `../emails/types.ts` on purpose: this module is
// the lowest layer of the API client and must not depend on a feature folder.
// Keep the two in sync. The backend's `routes/email.rs::get_emails` ignores
// unknown folder values (returns all), so the stub folders are safe to send.
export type EmailFolder =
  | "inbox"
  | "sent"
  | "important"
  | "updates"
  | "spam"
  | "drafts"
  | "social"
  | "trash"
  | "github";

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

export type EmailComposeAttachment = {
  filename: string;
  mime_type: string;
  content_base64: string;
};

export type SendEmailPayload = {
  account_id: number;
  to: string;
  subject: string;
  body: string;
  // Standard-mailbox attachments only (Gmail/Outlook MIME, not E2E).
  attachments?: EmailComposeAttachment[];
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

// Cached briefly because the emails page and its sidebar badge refetch accounts
// on every mount. The account mutations are non-GET, so they clear the cache.
export const getAccounts = async <T = unknown>() =>
  apiFetchJson<T[]>("/api/accounts", { cacheTtlMs: 15_000 });

export const getEmailsUnreadCount = async (): Promise<number> => {
  const data = await apiFetchJson<{ count: number }>(
    "/api/emails/unread-count"
  );
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
  const data = await apiFetchJson<{ url: string }>(
    "/api/email-providers/gmail/connect",
    { method: "POST" }
  );
  return data.url;
};

export const getOutlookConnectUrl = async () => {
  const data = await apiFetchJson<{ url: string }>(
    "/api/email-providers/outlook/connect",
    { method: "POST" }
  );
  return data.url;
};

export type ImapSettings = {
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  security: string; // "ssl" | "starttls"
};

// Returns either `{ use_oauth }` (the domain is on Google/Microsoft, so connect
// via OAuth instead) or guessed IMAP/SMTP settings the user can edit. Never
// throws on an unknown domain; it falls back to a guess.
export const imapAutodiscover = async (
  email: string
): Promise<{ use_oauth?: "google" | "microsoft" } & Partial<ImapSettings>> =>
  apiFetchJson("/api/email-providers/imap/autodiscover", {
    method: "POST",
    body: JSON.stringify({ email }),
  });

// Verifies credentials with a real IMAP LOGIN without persisting anything.
// Throws with the backend's user-facing message on failure.
export const imapTestLogin = async (input: {
  email: string;
  imap_host: string;
  imap_port: number;
  password: string;
}): Promise<{ ok: boolean }> =>
  apiFetchJson("/api/email-providers/imap/test-login", {
    method: "POST",
    body: JSON.stringify(input),
  });

// Verifies and persists the mailbox. Throws with the backend's user-facing
// message on failure.
export const connectImap = async (
  input: ImapSettings & { email: string; password: string }
): Promise<{ id: number; email: string; provider: string }> =>
  apiFetchJson("/api/email-providers/imap/connect", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const markEmailRead = async (emailId: number): Promise<void> => {
  await apiFetchJson(`/api/emails/${emailId}/read`, { method: "POST" });
  // Poke mounted unread-count badges so they refresh now instead of waiting for
  // the 60s poll. The listener lives in useEmailsUnreadCount.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("rwayve:emails-unread-changed"));
  }
};

// Maps an email address to a supported OAuth provider key (`"gmail"` or
// `"outlook"`). Throws on unsupported domains. See
// [provider_lookup.rs](../../../backend/src/email/provider_lookup.rs).
export const lookupEmailProvider = async (email: string): Promise<string> => {
  const data = await apiFetchJson<{ provider: string }>(
    "/api/email-providers/lookup",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }
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
 * Downloads an attachment, decrypting client-side when `userId` is given and
 * the bytes carry the WV1 envelope magic.
 *
 * Note that outbound attachments to non-Wayve recipients are NOT E2E-encrypted:
 * they go over plain Gmail/Outlook SMTP, because a foreign mail client cannot
 * decrypt our envelope. E2E attachments only work Wayve-to-Wayve.
 */
export const downloadEmailAttachment = async (
  attachment: EmailAttachment,
  userId: number | null = null
) => {
  const res = await apiFetch(
    `/api/email-attachments/${attachment.id}/download`
  );
  const ct = res.headers.get("content-type") ?? "application/octet-stream";
  const raw = new Uint8Array(await res.arrayBuffer());

  let blob: Blob;
  if (userId != null) {
    const { looksLikeEnvelope, decryptBlobForSelf } =
      await import("../crypto/fileEnvelope");
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

// Asks the backend to sync every account the caller owns now, ahead of the
// adaptive schedule. Errors are swallowed because this is best-effort latency
// reduction, not a correctness path: the 30s worker tick catches anything
// missed here.
export const wakeEmailSync = async (): Promise<void> => {
  try {
    await apiFetch("/api/email/wake", { method: "POST" });
  } catch {
    // Wake is a hint, not a guarantee.
  }
};

export const sendEmail = async (payload: SendEmailPayload) => {
  const res = await apiFetch("/api/emails", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return res.text();
};

// Standard base64, with the `data:` URL prefix stripped, as `content_base64`
// requires.
export const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });

export const filesToAttachments = async (
  files: File[]
): Promise<EmailComposeAttachment[]> =>
  Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      mime_type: file.type || "application/octet-stream",
      content_base64: await fileToBase64(file),
    }))
  );

// Must stay in sync with the backend's `MAX_OUTGOING_ATTACHMENTS_BYTES`.
export const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;

export type WayveRecipient = {
  id: number;
  email: string;
  /** SPKI public key bytes, as the server stores them (number array). */
  public_key: number[] | null;
};

/**
 * Resolves an address to a Wayve user so compose can encrypt to their RSA
 * public key. `null` means the address is not a Wayve user and the caller
 * should fall back to plain SMTP. Throws on transport errors so retries are
 * explicit.
 */
export const getUserByEmail = async (
  email: string
): Promise<WayveRecipient | null> => {
  const trimmed = email.trim();
  if (!trimmed) return null;
  const res = await apiFetch(`/api/users?email=${encodeURIComponent(trimmed)}`);
  const body = await res.json();
  if (!body || typeof body !== "object") return null;
  return body as WayveRecipient;
};

export type SendInternalPayload = {
  recipient_user_ids: number[];
  envelope: string;
  subject: string;
};

/**
 * Delivers a pre-encrypted multi-recipient envelope over the Wayve-to-Wayve
 * channel, no SMTP involved. The server never sees plaintext — only the opaque
 * envelope the browser built via `buildInternalEnvelope` (see
 * `frontend/src/emails/internalEnvelope.ts`) — and stores it once per recipient
 * plus a Sent copy.
 */
export const sendInternalEmail = async (payload: SendInternalPayload) => {
  const res = await apiFetch("/api/emails/internal", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.json() as Promise<{ delivered: number; sent_id: string }>;
};

export type SecureSendPayload = {
  recipient_email: string;
  subject: string;
  ciphertext: string;
  iv: string;
  wrapped_key: string;
  salt: string;
  pbkdf2_iterations: number;
};

/**
 * Uploads a pre-encrypted secure-message bundle. The server picks the token and
 * expiry and sends the notification email; the returned link lets the sender
 * share it manually if delivery fails.
 */
export const sendSecureEmail = async (payload: SecureSendPayload) => {
  const res = await apiFetch("/api/emails/secure", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.json() as Promise<{
    token: string;
    link: string;
    expires_at: string;
  }>;
};

/**
 * Public route, no auth header required: the magic-link read page pulls the
 * ciphertext bundle here for client-side decryption. Returns null when there is
 * no readable message, throws on other errors.
 */
export const fetchSecureMessage = async (token: string) => {
  const res = await apiFetch(
    `/api/secure-messages/${encodeURIComponent(token)}`,
    {
      preserve401: true,
      // 404 is an invalid token and 410 an expired one; both mean "no message".
      preserve404: true,
      preserve410: true,
    }
  );
  if (res.status === 404 || res.status === 410) return null;
  return res.json() as Promise<
    import("../emails/secureSend").ServerSecureMessage
  >;
};
