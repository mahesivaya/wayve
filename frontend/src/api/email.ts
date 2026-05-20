import { apiFetch, apiFetchJson } from "./client";

export type EmailFolder = "inbox" | "sent";

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

// Persist that the user has opened this email. The frontend flips `is_read`
// optimistically; this call is what makes the change survive a page refresh.
// Fire-and-forget — the caller logs failures but doesn't roll the UI back.
export const markEmailRead = async (emailId: number): Promise<void> => {
  await apiFetchJson(`/api/emails/${emailId}/read`, { method: "POST" });
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

export const downloadEmailAttachment = async (attachment: EmailAttachment) => {
  const res = await apiFetch(`/api/email-attachments/${attachment.id}/download`);
  const blob = await res.blob();
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
