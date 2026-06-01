// Typed API client for the org-master-key endpoints (mirrors
// backend/crates/wayve-server/src/organization/keys.rs). Every call goes
// through the shared apiFetch() helper so cookie/JWT auth is consistent.

import { apiFetch, apiFetchJson } from "../api/client";

export type MnemonicWrap = {
  iv: string;
  ct: string;
  pbkdf2_salt: string;
  pbkdf2_iterations: number;
};

export type UserPubkeyWrap = {
  iv: string;
  ct: string;
};

export type BootstrapKeysRequest = {
  // SPKI bytes as a JSON-array-of-bytes string — same wire shape as
  // users.public_key.
  public_key: string;
  wrapped_mnemonic: MnemonicWrap;
  wrapped_user: UserPubkeyWrap;
};

export type GetKeysResponse = {
  public_key: string;
  wrapped_user: UserPubkeyWrap | null;
  wrapped_mnemonic: MnemonicWrap | null;
};

export type MemberEscrowResponse = {
  envelope: string;
};

export type AuditEntry = {
  id: number;
  actor_user_id: number | null;
  actor_role: string | null;
  action: string;
  target_user_id: number | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
};

export type NewLoginWrap = {
  iv: string;
  ct: string;
  salt: string;
  iterations: number;
};

export async function bootstrapOrgKeys(
  orgId: number,
  body: BootstrapKeysRequest,
): Promise<void> {
  await apiFetch(`/api/organizations/${orgId}/keys`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getOrgKeys(
  orgId: number,
  opts: { includeMnemonic?: boolean } = {},
): Promise<GetKeysResponse> {
  const qs = opts.includeMnemonic ? "?include_mnemonic=true" : "";
  return apiFetchJson<GetKeysResponse>(`/api/organizations/${orgId}/keys${qs}`);
}

export async function getMemberEscrow(
  orgId: number,
  memberUserId: number,
): Promise<MemberEscrowResponse> {
  return apiFetchJson<MemberEscrowResponse>(
    `/api/organizations/${orgId}/members/${memberUserId}/escrow`,
  );
}

export async function addKeyHolderWrap(
  orgId: number,
  newHolderUserId: number,
  wrap: UserPubkeyWrap,
): Promise<void> {
  await apiFetch(`/api/organizations/${orgId}/key-holders`, {
    method: "POST",
    body: JSON.stringify({ user_id: newHolderUserId, wrapped_user: wrap }),
  });
}

export async function readAuditLog(orgId: number): Promise<AuditEntry[]> {
  return apiFetchJson<AuditEntry[]>(
    `/api/organizations/${orgId}/audit/key-access`,
  );
}

export type ResetMemberPasswordRequest = {
  new_password: string;
  new_login_wrap: NewLoginWrap;
};

export async function resetMemberPassword(
  orgId: number,
  memberUserId: number,
  body: ResetMemberPasswordRequest,
): Promise<void> {
  await apiFetch(
    `/api/organizations/${orgId}/members/${memberUserId}/reset-password`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}
