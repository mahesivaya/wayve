// Typed client for the organization custom-domain endpoints (mirrors
// backend/crates/wayve-server/src/organization/domains.rs). All endpoints
// are platform-owner only; calls go through the shared apiFetch() helper so
// cookie/JWT auth is consistent.

import { apiFetch } from "../api/client";

export type OrgDomain = {
  id: number;
  organization_id: number;
  domain: string;
  verified: boolean;
  verified_at: string | null;
  last_checked_at: string | null;
  created_at: string;
  // Present while unverified: the DNS TXT record the org must publish.
  txt_name: string | null;
  txt_value: string | null;
};

export type VerifyResult = {
  verified: boolean;
  domain: string;
  message?: string;
  txt_name?: string;
  txt_value?: string;
};

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? fallback;
  } catch {
    return fallback;
  }
}

export async function listOrgDomains(orgId: number): Promise<OrgDomain[]> {
  const res = await apiFetch(`/api/organizations/${orgId}/domains`);
  if (!res.ok) throw new Error(await readError(res, "Failed to load domains"));
  return (await res.json()) as OrgDomain[];
}

export async function claimOrgDomain(
  orgId: number,
  domain: string
): Promise<OrgDomain> {
  const res = await apiFetch(`/api/organizations/${orgId}/domains`, {
    method: "POST",
    body: JSON.stringify({ domain }),
  });
  if (!res.ok) throw new Error(await readError(res, "Failed to claim domain"));
  return (await res.json()) as OrgDomain;
}

export async function verifyOrgDomain(
  orgId: number,
  domainId: number
): Promise<VerifyResult> {
  const res = await apiFetch(
    `/api/organizations/${orgId}/domains/${domainId}/verify`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error(await readError(res, "Verification failed"));
  return (await res.json()) as VerifyResult;
}

export async function deleteOrgDomain(
  orgId: number,
  domainId: number
): Promise<void> {
  const res = await apiFetch(
    `/api/organizations/${orgId}/domains/${domainId}`,
    {
      method: "DELETE",
    }
  );
  if (!res.ok) throw new Error(await readError(res, "Failed to delete domain"));
}

// Per-org policy: when true, the org may create member addresses on any domain
// (public providers + unverified), bypassing the domain-ownership gate.
export async function getOrgDomainPolicy(orgId: number): Promise<boolean> {
  const res = await apiFetch(`/api/organizations/${orgId}/domain-policy`);
  if (!res.ok) throw new Error(await readError(res, "Failed to load policy"));
  const data = (await res.json()) as {
    allow_unverified_email_domains: boolean;
  };
  return data.allow_unverified_email_domains;
}

export async function setOrgDomainPolicy(
  orgId: number,
  allow: boolean
): Promise<boolean> {
  const res = await apiFetch(`/api/organizations/${orgId}/domain-policy`, {
    method: "PUT",
    body: JSON.stringify({ allow }),
  });
  if (!res.ok) throw new Error(await readError(res, "Failed to update policy"));
  const data = (await res.json()) as {
    allow_unverified_email_domains: boolean;
  };
  return data.allow_unverified_email_domains;
}
