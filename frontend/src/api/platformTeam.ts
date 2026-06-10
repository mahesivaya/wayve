import { apiFetchJson } from "./client";

export type DeveloperKeyRow = {
  id: number;
  name: string;
  key_preview: string;
  key_type: string;
  scopes: string[];
  owner_name: string;
  calls_24h: number;
  last_used_at: string | null;
};

export type DeveloperAuditRow = {
  id: number;
  method: string;
  path: string;
  status_code: number;
  outcome: string;
  ip: string | null;
  key_name: string | null;
  key_preview: string | null;
  created_at: string | null;
};

export type DeveloperEndpointRow = {
  path: string;
  calls: number;
  errors: number;
};

export type DeveloperSummary = {
  keys_total: number;
  keys_active: number;
  keys_usable: number;
  keys_expired: number;
  audit_24h: number;
  audit_7d: number;
  audit_failures_24h: number;
  rate_limited_24h: number;
  webhooks_7d: number;
  sso_integrations: number;
  top_keys: DeveloperKeyRow[];
  recent_audit: DeveloperAuditRow[];
  top_endpoints: DeveloperEndpointRow[];
};

export type SupportOrganizationRow = {
  id: number;
  name: string;
  slug: string | null;
  member_count: number;
  mailboxes: number;
  sub_status: string;
  plan_name: string | null;
};

export type SupportSignupRow = {
  id: number;
  email: string;
  username: string | null;
  account_type: string;
  auth_provider: string | null;
  created_at: string | null;
};

export type SupportInboxRow = {
  email_id: number;
  status: string;
  subject: string | null;
  inbox_email: string | null;
  assignee_email: string | null;
  updated_at: string | null;
};

export type SupportSummary = {
  users_total: number;
  users_new_7d: number;
  users_new_24h: number;
  orgs_total: number;
  active_subs: number;
  past_due: number;
  connected_mailboxes: number;
  shared_inboxes: number;
  open_inbox_threads: number;
  pending_inbox_threads: number;
  top_organizations: SupportOrganizationRow[];
  recent_signups: SupportSignupRow[];
  open_inbox_queue: SupportInboxRow[];
};

export const getDeveloperSummary = () =>
  apiFetchJson<DeveloperSummary>("/api/platform-team/developer-summary");

export const getSupportSummary = () =>
  apiFetchJson<SupportSummary>("/api/platform-team/support-summary");

export type UsersSummary = {
  users_total: number;
  users_new_1m: number;
  users_new_1y: number;
  emails_total: number;
  storage_used_bytes: number;
};

export const getUsersSummary = () =>
  apiFetchJson<UsersSummary>("/api/platform-team/users-summary");

export type PlatformUserRow = {
  id: number;
  email: string;
  username: string | null;
  created_at: string | null;
  storage_bytes: number;
};

export type ListPlatformUsersParams = {
  accountType?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

// Per-user table for the platform Users page: email + memory used. Defaults to
// personal users. Storage is computed server-side per row (matches /profile).
export const listPlatformUsers = (params: ListPlatformUsersParams = {}) => {
  const search = new URLSearchParams();
  search.set("account_type", params.accountType ?? "personal");
  if (params.q) search.set("q", params.q);
  if (params.limit != null) search.set("limit", String(params.limit));
  if (params.offset != null) search.set("offset", String(params.offset));
  return apiFetchJson<{ users: PlatformUserRow[] }>(
    `/api/platform-team/users?${search.toString()}`
  );
};
