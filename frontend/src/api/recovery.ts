// Wrapped-key API client. Pairs with backend/src/routes/recovery.rs.
//
// The envelope is opaque to the server — the mnemonic that derives the
// wrapping key never reaches network. We just POST/GET ciphertext bytes.

import { apiFetch } from "./client";
import type { WrappedKeyEnvelope } from "../crypto/recovery";

type ServerWrappedKey = WrappedKeyEnvelope & { updated_at: string };

/**
 * Upload (or replace) the user's wrapped private key. Idempotent —
 * subsequent calls overwrite the prior wrap, which is correct after the
 * user regenerates or re-wraps their key.
 */
export async function uploadWrappedKey(envelope: WrappedKeyEnvelope): Promise<void> {
  await apiFetch("/api/me/wrapped-key", {
    method: "PUT",
    body: JSON.stringify(envelope),
  });
}

/**
 * Fetch the wrapped key for the signed-in user. Returns null when no
 * recovery copy is on file (the backend returns 404). `preserve401`
 * keeps the existing session valid through this lookup.
 */
export async function fetchWrappedKey(): Promise<ServerWrappedKey | null> {
  const res = await apiFetch("/api/me/wrapped-key", {
    preserve401: true,
    // 404 = no recovery key on file yet (a fresh / SQL-seeded account).
    // Without this, apiFetch throws on the 404 and setupEncryption aborts
    // before it can generate keys + show the recovery-seed modal.
    preserve404: true,
  });
  if (res.status === 404) return null;
  return (await res.json()) as ServerWrappedKey;
}

export async function deleteWrappedKey(): Promise<void> {
  await apiFetch("/api/me/wrapped-key", { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Legacy basic-key client — migration only
// ---------------------------------------------------------------------------
//
// Plan A retired the server-held PKCS8 escrow flow. These calls exist
// only to migrate users who were on the old 'basic' mode: GET pulls the
// legacy envelope (returns null once the row has been migrated and the
// columns nulled), and DELETE wipes it after the SPA has wrapped the
// private key under a fresh BIP-39 mnemonic. PUT now returns 410 from
// the server; the upload helper is retained for backwards-compat call
// sites and is a no-op outside of tests.

/** Legacy: PUT is 410 Gone on the server. Kept to avoid breaking imports. */
export async function uploadBasicKey(_pkcs8Bytes: ArrayBuffer): Promise<void> {
  // Server returns 410 under Plan A. Don't even round-trip; treat as a
  // silent no-op so existing call paths during the migration window
  // don't surface a misleading error. Real call sites should be removed
  // as part of the AuthContext rewrite.
  return;
}

/**
 * Fetch the legacy server-held PKCS8 envelope (if any) so a migrating
 * user can recover their pre-Plan-A RSA private key and re-wrap it
 * under a new mnemonic. Returns null once the row has been migrated.
 */
export async function fetchBasicKey(): Promise<ArrayBuffer | null> {
  const res = await apiFetch("/api/me/basic-key", {
    preserve401: true,
    // 404 = no legacy key (the normal case post-migration); return null
    // rather than throwing so the migration probe stays quiet.
    preserve404: true,
  });
  if (res.status === 404) return null;
  const body = (await res.json()) as { pkcs8: string };
  const binary = atob(body.pkcs8);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

/**
 * Wipe the legacy server-held PKCS8 envelope. Call this right after a
 * successful uploadWrappedKey() so the mnemonic becomes the only path
 * back into the account.
 */
export async function deleteBasicKey(): Promise<void> {
  await apiFetch("/api/me/basic-key", { method: "DELETE" });
}
