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
  const res = await apiFetch("/api/me/wrapped-key", { preserve401: true });
  if (res.status === 404) return null;
  return (await res.json()) as ServerWrappedKey;
}

export async function deleteWrappedKey(): Promise<void> {
  await apiFetch("/api/me/wrapped-key", { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Basic-mode private-key client
// ---------------------------------------------------------------------------
//
// Only valid for users with `recovery_mode = 'basic'`. Server stores the
// PKCS8 plaintext encrypted at rest with AES_KEY and ships it back in
// plaintext over TLS so the browser can load it into IndexedDB on a new
// device. password_only / full users get 404 from these endpoints —
// they don't escrow keys with the server.

/** Upload the plaintext PKCS8 of the user's RSA private key to the server. */
export async function uploadBasicKey(pkcs8Bytes: ArrayBuffer): Promise<void> {
  const bytes = new Uint8Array(pkcs8Bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const pkcs8 = btoa(binary);
  await apiFetch("/api/me/basic-key", {
    method: "PUT",
    body: JSON.stringify({ pkcs8 }),
  });
}

/**
 * Fetch the plaintext PKCS8 of the user's basic-mode private key.
 * Returns null when no key is on file (server returns 404 — typical on
 * the first login right after registration if the prior upload didn't
 * land).
 */
export async function fetchBasicKey(): Promise<ArrayBuffer | null> {
  const res = await apiFetch("/api/me/basic-key", { preserve401: true });
  if (res.status === 404) return null;
  const body = (await res.json()) as { pkcs8: string };
  const binary = atob(body.pkcs8);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}
