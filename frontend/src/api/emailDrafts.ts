import { apiFetch, apiFetchJson } from "./client";

export type DraftKind = "compose" | "reply" | "forward";

export type DraftContent = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
};

export type EmailDraft = DraftContent & {
  id: number;
  kind: DraftKind;
  // Null for a new email, or when the original has since been deleted.
  source_email_id: number | null;
  account_id: number | null;
  created_at: string;
  updated_at: string;
};

export type NewDraft = DraftContent & {
  kind: DraftKind;
  source_email_id: number | null;
  account_id: number | null;
};

export type SaveOptions = {
  // Lets the request outlive a closing tab. Browsers refuse bodies over 64 KB.
  keepalive?: boolean;
};

const json = (method: string, body: unknown, options?: SaveOptions) => ({
  method,
  body: JSON.stringify(body),
  keepalive: options?.keepalive,
});

export const listEmailDrafts = () =>
  apiFetchJson<EmailDraft[]>("/api/email/drafts");

// A reply or forward has one draft per source email, so this overwrites any draft
// already saved for it (from another tab, say) rather than adding a second.
export const createEmailDraft = (draft: NewDraft, options?: SaveOptions) =>
  apiFetchJson<EmailDraft>("/api/email/drafts", json("POST", draft, options));

// Resolves to null when the draft is gone, sent or discarded in another tab.
export const updateEmailDraft = async (
  id: number,
  draft: DraftContent & { account_id: number | null },
  options?: SaveOptions
): Promise<EmailDraft | null> => {
  const res = await apiFetch(`/api/email/drafts/${id}`, {
    ...json("PUT", draft, options),
    preserve404: true,
  });
  return res.status === 404 ? null : ((await res.json()) as EmailDraft);
};

export const deleteEmailDraft = async (id: number, options?: SaveOptions) => {
  await apiFetch(`/api/email/drafts/${id}`, {
    method: "DELETE",
    keepalive: options?.keepalive,
  });
};
