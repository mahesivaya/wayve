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
  | "social"
  | "trash";

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

// Cached for 15s: the emails page (and its sidebar badge) fetch accounts on
// every mount/navigation. deleteAccount / updateAccountDisplayName / OAuth
// connect are non-GET, so they clear the GET cache and a fresh list loads.
export const getAccounts = async <T = unknown>() =>
  apiFetchJson<T[]>("/api/accounts", { cacheTtlMs: 15_000 });

// Total unread email count across all of the user's accounts. Backed by the
// `idx_emails_unread` partial index, so this is cheap even on a huge inbox.
// Powers the sidebar nav badge (and the "All Accounts" filter badge) without
// loading the full inbox to count locally.
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

// Yahoo doesn't use OAuth — the caller posts the email + app password
// directly and the backend verifies via IMAP LOGIN before persisting the
// credentials (encrypted at rest). Returns the new email_accounts row id
// on success; throws with the backend's user-facing message on failure.
export const connectYahoo = async (
  email: string,
  appPassword: string
): Promise<{ id: number; email: string; provider: string }> => {
  return apiFetchJson<{ id: number; email: string; provider: string }>(
    "/api/email-providers/yahoo/connect",
    {
      method: "POST",
      body: JSON.stringify({ email, app_password: appPassword }),
    }
  );
};

// Persist that the user has opened this email. The frontend flips `is_read`
// optimistically; this call is what makes the change survive a page refresh.
// Fire-and-forget — the caller logs failures but doesn't roll the UI back.

// ── Generic IMAP/SMTP (any custom-domain mailbox) ──────────────────────────

export type ImapSettings = {
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  security: string; // "ssl" | "starttls"
};

// Autodiscover connection settings from the email's domain. Either returns
// `{ use_oauth }` (the domain is on Google/Microsoft — connect via OAuth
// instead) or guessed IMAP/SMTP settings (which the user can edit before
// testing). Never throws on an unknown domain — it falls back to a guess.
export const imapAutodiscover = async (
  email: string
): Promise<{ use_oauth?: "google" | "microsoft" } & Partial<ImapSettings>> =>
  apiFetchJson("/api/email-providers/imap/autodiscover", {
    method: "POST",
    body: JSON.stringify({ email }),
  });

// Verify credentials with a real IMAP LOGIN without persisting anything.
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

// Verify + persist the IMAP/SMTP mailbox. Returns the new account row id.
// Throws with the backend's user-facing message on failure.
export const connectImap = async (
  input: ImapSettings & { email: string; password: string }
): Promise<{ id: number; email: string; provider: string }> =>
  apiFetchJson("/api/email-providers/imap/connect", {
    method: "POST",
    body: JSON.stringify(input),
  });

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

// Fire-and-forget: ask the backend to sync every email account the
// caller owns RIGHT NOW, bypassing the adaptive per-account schedule.
// The endpoint returns 202 Accepted as soon as the syncs are queued —
// the actual work happens in a background tokio task on the backend.
// The next inbox poll (≤60 s away) picks up anything new.
//
// Errors are swallowed; this is best-effort latency reduction, not a
// correctness path. The 30-second worker tick still catches anything
// that didn't sync here.
export const wakeEmailSync = async (): Promise<void> => {
  try {
    await apiFetch("/api/email/wake", { method: "POST" });
  } catch {
    // Intentional: wake is a hint, not a guarantee.
  }
};

export const sendEmail = async (payload: SendEmailPayload) => {
  const res = await apiFetch("/api/emails", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return res.text();
};

// ---------------------------------------------------------------------------
// Plan A Phase 2 — Wayve-to-Wayve native channel
// ---------------------------------------------------------------------------
//
// `getUserByEmail` resolves a recipient address to a Wayve user record so
// the compose flow can detect "this person is on Wayve" and (when they
// are) encrypt to their RSA public key. Returns null when the address
// is not a Wayve user — fall back to the standard SMTP send path.
//
// `sendInternalEmail` POSTs a pre-built multi-recipient envelope to the
// backend's send-internal endpoint. The server never sees plaintext —
// only the opaque envelope string the browser produced via
// `buildInternalEnvelope` (see `frontend/src/emails/internalEnvelope.ts`).

export type WayveRecipient = {
  id: number;
  email: string;
  /** SPKI public key bytes, as the server stores them (number array). */
  public_key: number[] | null;
};

/**
 * Resolve an email address to a Wayve user. Returns `null` for unknown
 * addresses (which means: not a Wayve user — caller should use plain
 * SMTP). Throws on transport errors so retries are explicit.
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
 * Deliver a pre-encrypted multi-recipient envelope through the
 * Wayve-to-Wayve native channel. No SMTP involved; the backend stores
 * one row per recipient + one Sent copy for the sender, all carrying
 * the same opaque envelope.
 */
export const sendInternalEmail = async (payload: SendInternalPayload) => {
  const res = await apiFetch("/api/emails/internal", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.json() as Promise<{ delivered: number; sent_id: string }>;
};

// ---------------------------------------------------------------------------
// Plan A Phase 3 — Secure-send magic link
// ---------------------------------------------------------------------------

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
 * Upload a pre-encrypted secure message bundle. Server picks the token
 * + expiry and fires the notification email; we get back the token +
 * link the sender can copy (e.g., to share the link manually if SES
 * fails to deliver).
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
 * Public-route fetch — no auth header required. Used by the magic-link
 * read page to pull the ciphertext bundle for client-side decryption.
 * Returns null on 404 (invalid token), throws on other errors.
 */
export const fetchSecureMessage = async (token: string) => {
  const res = await apiFetch(
    `/api/secure-messages/${encodeURIComponent(token)}`,
    {
      preserve401: true,
      // 404 = invalid token, 410 = expired; both mean "no message", return
      // null instead of throwing.
      preserve404: true,
      preserve410: true,
    }
  );
  if (res.status === 404 || res.status === 410) return null;
  return res.json() as Promise<
    import("../emails/secureSend").ServerSecureMessage
  >;
};
