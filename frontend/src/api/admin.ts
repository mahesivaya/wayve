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
  admin?: AdminCreatedUser | null;
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

// Self-serve: a personal user creates an organization for themselves and
// is promoted to its owner. Returns the new org plus the new account_type
// so the caller can refresh AuthContext. The starter entitlement grants
// `seat_limit` (currently 100) free seats so the owner can invite members
// before subscribing.
export type CreatedMyOrganization = {
  id: number;
  name: string;
  slug: string | null;
  place: string | null;
  account_type: string;
  organization_id: number;
  role: string;
  seat_limit: number;
};

export async function createMyOrganization(input: {
  name: string;
  place?: string;
}): Promise<CreatedMyOrganization> {
  const res = await apiFetch("/api/organizations", {
    method: "POST",
    preserve401: true,
    body: JSON.stringify({
      name: input.name,
      place: input.place && input.place.trim() ? input.place.trim() : null,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || "Failed to create organization");
  }

  return data;
}

// Payment-gated org creation. Step 1 starts the organization-plan
// subscription billed to the founder's personal Stripe customer; NO org is
// created until the charge clears.
//   - "saved" card that clears synchronously → server finalizes and returns
//     the created org ({ kind: "created" }).
//   - otherwise → returns a client_secret to confirm with a Payment Element
//     ({ kind: "needs_payment" }), after which the caller calls
//     finalizeOrgSignup().
export type OrgSignupIntentResult =
  | { kind: "created"; org: CreatedMyOrganization }
  | {
      kind: "needs_payment";
      pending_id: number;
      client_secret: string;
      publishable_key: string | null;
    };

export async function orgSignupIntent(input: {
  name: string;
  place?: string;
  admin_email?: string;
  payment_choice: "saved" | "new";
  plan_code?: string;
}): Promise<OrgSignupIntentResult> {
  const res = await apiFetch("/api/organizations/signup-intent", {
    method: "POST",
    preserve401: true,
    body: JSON.stringify({
      name: input.name,
      place: input.place && input.place.trim() ? input.place.trim() : null,
      admin_email:
        input.admin_email && input.admin_email.trim()
          ? input.admin_email.trim()
          : null,
      payment_choice: input.payment_choice,
      plan_code: input.plan_code ?? null,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || "Could not start organization signup");
  }
  // Saved-card path that cleared synchronously comes back as the created org
  // (HTTP 201, no client_secret); the new-card path returns a client_secret.
  if (typeof data.client_secret === "string") {
    return {
      kind: "needs_payment",
      pending_id: data.pending_id,
      client_secret: data.client_secret,
      publishable_key: data.publishable_key ?? null,
    };
  }
  return { kind: "created", org: data as CreatedMyOrganization };
}

// Step 2: verify the charge + create the org. Idempotent server-side.
export async function finalizeOrgSignup(
  pendingId: number
): Promise<CreatedMyOrganization> {
  const res = await apiFetch("/api/organizations/finalize", {
    method: "POST",
    preserve401: true,
    body: JSON.stringify({ pending_id: pendingId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.message || "Could not finish creating the organization"
    );
  }
  return data;
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

// Creates a user as the calling admin. `email` is the full login address; the
// caller builds it from a handle and the organization domain (or wayve.com for
// personal accounts).
export async function createAdminUser(
  username: string,
  email: string,
  password: string,
  accountType = "personal",
  organizationName = "",
  role?: string
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
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || "Failed to create user");
  }

  return data;
}
