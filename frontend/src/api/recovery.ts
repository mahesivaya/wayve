// Wrapped-key API client. Pairs with backend/src/routes/recovery.rs.
//
// The envelope is opaque to the server: the mnemonic that derives the wrapping
// key never reaches the network, so only ciphertext bytes cross this boundary.

import { apiFetch } from "./client";
import type { WrappedKeyEnvelope } from "../crypto/recovery";

type ServerWrappedKey = WrappedKeyEnvelope & { updated_at: string };

// Idempotent: a later call overwrites the prior wrap, which is what we want
// after the user regenerates or re-wraps their key.
export async function uploadWrappedKey(
  envelope: WrappedKeyEnvelope
): Promise<void> {
  await apiFetch("/api/me/wrapped-key", {
    method: "PUT",
    body: JSON.stringify(envelope),
  });
}

// Returns null when no recovery copy is on file yet. Without `preserve404`,
// apiFetch would throw and setupEncryption would abort before it could generate
// keys and show the recovery-seed modal.
export async function fetchWrappedKey(): Promise<ServerWrappedKey | null> {
  const res = await apiFetch("/api/me/wrapped-key", {
    preserve401: true,
    preserve404: true,
  });
  if (res.status === 404) return null;
  return (await res.json()) as ServerWrappedKey;
}

export async function deleteWrappedKey(): Promise<void> {
  await apiFetch("/api/me/wrapped-key", { method: "DELETE" });
}

// The basic-key calls below exist only to migrate users off the retired
// server-held PKCS8 escrow flow, and should go away once no rows remain.

// The server answers PUT with 410, so this is a deliberate no-op rather than a
// round-trip, kept only so old call sites keep resolving.
export async function uploadBasicKey(_pkcs8Bytes: ArrayBuffer): Promise<void> {
  return;
}

// Pulls the legacy envelope so a migrating user can recover their old RSA key
// and re-wrap it under a new mnemonic. Returns null once the row is migrated,
// the normal case, and preserves the 404 so this probe stays quiet.
export async function fetchBasicKey(): Promise<ArrayBuffer | null> {
  const res = await apiFetch("/api/me/basic-key", {
    preserve401: true,
    preserve404: true,
  });
  if (res.status === 404) return null;
  const body = (await res.json()) as { pkcs8: string };
  const binary = atob(body.pkcs8);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

// Call this right after a successful uploadWrappedKey() so the mnemonic becomes
// the only path back into the account.
export async function deleteBasicKey(): Promise<void> {
  await apiFetch("/api/me/basic-key", { method: "DELETE" });
}
