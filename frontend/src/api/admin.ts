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
  // The org's active-subscription plan code + tier. "none" / null when the org
  // has no active subscription. Drives the Business vs Enterprise page split.
  plan_code?: string | null;
  tier?: string | null;
};

// The organization admin to provision alongside the new organization. The
// caller supplies the full login email, built from the admin handle and the
// organization slug as <adminHandle>@<org-slug>.com.
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

// Provision a new ENTERPRISE organization + its owner account in one call. Same
// endpoint as createAdminOrganization, with `tier: "enterprise"` so the backend
// also attaches an active enterprise subscription (the org is enterprise-tier
// immediately — the gate for Slack / MCP / standard-encryption features).
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

// A stored API key as shown in the admin UI. `key_preview` is redacted; the
// raw key is returned only once, by generateOrganizationApiKey.
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

// Tear down the caller's organization and revert them to a personal
// account. The backend deletes every invitee account in the org, drops
// the org row (cascades members, entitlements, billing rows), and flips
// the owner back to account_type='personal'. Refuses with 409 if an
// active Stripe subscription exists — cancel from /billing first.
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

// Rename the caller's organization. Owner-only on the backend; the slug is
// re-derived server-side from the new name. 409 if another org already uses
// the name.
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

// Permanently delete the caller's OWN account and all data cascading from it.
// Refuses with 409 if the caller still owns an organization (delete it first)
// or has an active Stripe subscription (cancel from /billing first).
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

// Step 1 of admin account creation: mail a 6-digit code that proves someone can
// receive mail for the new account. No user is created by this call.
//
// `deliveryEmail` is where the code is actually sent, and defaults server-side
// to `accountEmail`. They differ for org accounts, whose login address sits on a
// synthetic <user>@<org-slug>.com domain with no real inbox — the code goes to
// the person's reachable mailbox instead. The code is never returned here; it
// comes back from the admin, who reads it out of that inbox.
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

// Step 2: creates a user as the calling admin. `email` is the full login
// address; the caller builds it from a handle and the organization domain (or
// wayve.com for personal accounts). `verificationCode` is the code mailed by
// sendAdminCreateCode — the backend rejects the call without a valid one, so
// this always follows a send.
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
