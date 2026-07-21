import { apiFetch } from "./client";

export type AdminCreatedUser = {
  id: number;
  username: string | null;
  email: string;
  account_type: string;
  organization_id?: number | null;
};

export type AdminOrganization = {
  id: number;
  name: string;
  slug?: string | null;
  user_count: number;
  email_account_count?: number;
  storage_used_bytes?: number;
  created_at?: string | null;
  admin?: AdminCreatedUser | null;
  // From the org's active subscription; "none" or null when it has none. Drives
  // the Business vs Enterprise page split.
  plan_code?: string | null;
  tier?: string | null;
};

// The admin to provision alongside the new organization. The caller supplies
// the full login email, built as <adminHandle>@<org-slug>.com.
export type CreateOrganizationInput = {
  name: string;
  adminUsername: string;
  adminEmail: string;
  adminPassword: string;
};

export async function listAdminOrganizations(): Promise<AdminOrganization[]> {
  const res = await apiFetch("/api/admin/organizations", {
    preserve401: true,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || "Failed to load organizations");
  }

  return data;
}

export async function createAdminOrganization(
  input: CreateOrganizationInput
): Promise<AdminOrganization> {
  const res = await apiFetch("/api/admin/organizations", {
    method: "POST",
    preserve401: true,
    body: JSON.stringify({
      name: input.name,
      admin_username: input.adminUsername,
      admin_email: input.adminEmail,
      admin_password: input.adminPassword,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || "Failed to create organization");
  }

  return data;
}

// Same endpoint as createAdminOrganization, but `tier: "enterprise"` also
// attaches an active enterprise subscription, so the org immediately clears the
// gate on Slack, MCP, and standard-encryption features.
export async function createEnterpriseOrganization(
  input: CreateOrganizationInput
): Promise<AdminOrganization> {
  const res = await apiFetch("/api/admin/organizations", {
    method: "POST",
    preserve401: true,
    body: JSON.stringify({
      name: input.name,
      admin_username: input.adminUsername,
      admin_email: input.adminEmail,
      admin_password: input.adminPassword,
      tier: "enterprise",
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || "Failed to create enterprise");
  }

  return data;
}

// `key_preview` is redacted. The raw key is returned exactly once, by
// generateOrganizationApiKey, and is unrecoverable afterwards.
export type ApiKey = {
  id: number;
  name: string;
  key_preview: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type GeneratedApiKey = {
  id: number;
  name: string;
  key_preview: string;
  created_at: string;
  api_key: string;
};

export async function generateOrganizationApiKey(
  organizationId: number,
  name: string
): Promise<GeneratedApiKey> {
  const res = await apiFetch(
    `/api/admin/organizations/${organizationId}/keys`,
    {
      method: "POST",
      preserve401: true,
      body: JSON.stringify({ name }),
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || "Failed to generate API key");
  }

  return data;
}

export async function listOrganizationApiKeys(
  organizationId: number
): Promise<ApiKey[]> {
  const res = await apiFetch(
    `/api/admin/organizations/${organizationId}/keys`,
    {
      preserve401: true,
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || "Failed to load API keys");
  }

  return data;
}

export async function revokeOrganizationApiKey(
  organizationId: number,
  keyId: number
): Promise<void> {
  await apiFetch(`/api/admin/organizations/${organizationId}/keys/${keyId}`, {
    method: "DELETE",
    preserve401: true,
  });
}

export type DeletedMyOrganization = {
  deleted_organization_id: number;
  deleted_member_count: number;
  account_type: string;
};

// Tears down the org, deletes every invitee account, and reverts the caller to
// a personal account. Refuses with 409 while an active Stripe subscription
// exists, which must be cancelled from /billing first.
export async function deleteMyOrganization(): Promise<DeletedMyOrganization> {
  const res = await apiFetch("/api/organizations/me", {
    method: "DELETE",
    preserve401: true,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || "Failed to delete organization");
  }

  return data;
}

export type UpdatedOrganization = {
  id: number;
  name: string;
  slug: string | null;
};

// Owner-only. The slug is re-derived server-side from the new name, and a 409
// comes back if another org already uses it.
export async function updateMyOrganization(
  name: string
): Promise<UpdatedOrganization> {
  const res = await apiFetch("/api/organizations/me", {
    method: "PATCH",
    body: JSON.stringify({ name }),
    preserve401: true,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || "Failed to rename organization");
  }

  return data;
}

// Admin-only (org:settings). Sets the sprint (cycle) length in days, 1–90, that
// the user-stories burnup uses.
export async function updateOrgSprintDays(days: number): Promise<void> {
  const res = await apiFetch("/api/organizations/me/sprint-days", {
    method: "PATCH",
    body: JSON.stringify({ days }),
    preserve401: true,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || "Failed to update sprint length");
  }
}

// Refuses with 409 while the caller still owns an organization or has an active
// Stripe subscription; both must be torn down first.
export async function deleteMyAccount(): Promise<void> {
  const res = await apiFetch("/api/me", {
    method: "DELETE",
    preserve401: true,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || "Failed to delete account");
  }
}

export type SentCreateCode = {
  sent: boolean;
  delivery_email: string;
  expires_in_minutes: number;
};

// Step 1: mail a 6-digit code proving someone can receive mail for the new
// account. No user is created, and the code is never returned — the admin reads
// it from the inbox and types it back.
//
// `deliveryEmail` defaults to `accountEmail`. They differ for org accounts,
// whose login address is on a synthetic <user>@<org-slug>.com domain with no
// real inbox, so the code goes to a reachable mailbox instead.
export async function sendAdminCreateCode(
  accountEmail: string,
  deliveryEmail?: string
): Promise<SentCreateCode> {
  const res = await apiFetch("/api/admin/users/send-code", {
    method: "POST",
    preserve401: true,
    body: JSON.stringify({
      account_email: accountEmail,
      ...(deliveryEmail ? { delivery_email: deliveryEmail } : {}),
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || "Failed to send verification code");
  }

  return data;
}

// Step 2, always preceded by sendAdminCreateCode: the backend rejects this
// without the code that call mailed. `email` is the full login address, built
// from a handle plus the org domain, or wayve.com for personal accounts.
export async function createAdminUser(
  username: string,
  email: string,
  password: string,
  accountType = "personal",
  organizationName = "",
  role?: string,
  verificationCode?: string
): Promise<AdminCreatedUser> {
  const res = await apiFetch("/api/admin/users", {
    method: "POST",
    preserve401: true,
    body: JSON.stringify({
      username,
      email,
      password,
      account_type: accountType,
      organization_name: organizationName,
      ...(role ? { role } : {}),
      ...(verificationCode ? { verification_code: verificationCode } : {}),
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || "Failed to create user");
  }

  return data;
}
