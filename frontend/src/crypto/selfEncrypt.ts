// Self-encryption helpers for owner-only surfaces such as notes. Content goes
// into the same envelope shape chat uses, but with a single recipient: the user
// themselves.
//
// Mirroring the chat envelope rather than inventing a format keeps one decoder
// path across chat, notes, drive and attachments; leaves the multi-recipient
// "keys" dict in place for shared notes later; and lets the server detect an
// encrypted row with a single prefix check.

import { decryptMessage } from "./crypto";
import { loadPublicKey, loadPrivateKey } from "./keyStore";

const SELF_PREFIX = "WAYVE_SECURE_V1\n";

type SelfEnvelope = {
  type: "wayve_self_v1";
  data: number[];
  iv: number[];
  keys: Record<string, number[]>;
};

const toArrayBuffer = (input: ArrayBuffer | Uint8Array) =>
  input instanceof Uint8Array ? input.slice().buffer : input;

async function importOwnPublicKey(userId: number): Promise<CryptoKey> {
  const raw = await loadPublicKey(userId);
  if (!raw) {
    throw new Error(
      "No public key on this device — generate or restore your encryption key first."
    );
  }
  return crypto.subtle.importKey(
    "spki",
    toArrayBuffer(raw),
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"]
  );
}

/**
 * Encrypt `plaintext` under a fresh AES-256-GCM key, then wrap that key with the
 * user's own RSA public key. The resulting envelope string is stored verbatim in
 * the notes and title columns, and `decryptForSelf` reverses it.
 */
export async function encryptForSelf(
  plaintext: string,
  userId: number
): Promise<string> {
  if (plaintext.length === 0) {
    // An empty-string envelope would be indistinguishable from an empty cell, so
    // callers must treat "" as "no content" and skip encryption entirely.
    return "";
  }

  const publicKey = await importOwnPublicKey(userId);

  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(plaintext)
  );

  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    rawAesKey
  );

  const envelope: SelfEnvelope = {
    type: "wayve_self_v1",
    data: Array.from(new Uint8Array(ciphertext)),
    iv: Array.from(iv),
    keys: { [String(userId)]: Array.from(new Uint8Array(wrappedKey)) },
  };

  return `${SELF_PREFIX}${JSON.stringify(envelope)}`;
}

/**
 * Preserves backward compatibility with plaintext rows that pre-date this
 * feature: any string without the prefix is passed through untouched.
 */
export function isSelfEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(SELF_PREFIX);
}

/**
 * Reverses `encryptForSelf`. A non-envelope input is returned unchanged, so
 * callers don't have to branch. A decryption failure returns a placeholder
 * string rather than throwing: one unreadable note must not crash the list.
 */
export async function decryptForSelf(
  value: string,
  userId: number
): Promise<string> {
  if (!isSelfEncrypted(value)) return value;

  let envelope: SelfEnvelope;
  try {
    envelope = JSON.parse(value.slice(SELF_PREFIX.length)) as SelfEnvelope;
  } catch {
    return "[encrypted — corrupted envelope]";
  }
  if (envelope.type !== "wayve_self_v1") {
    return "[encrypted — unknown envelope version]";
  }

  const wrappedKey = envelope.keys[String(userId)];
  if (!wrappedKey) {
    return "[encrypted — no key entry for this user]";
  }

  const privateKey = await loadPrivateKey(userId);
  if (!privateKey) {
    return "[encrypted — key not on this device]";
  }

  try {
    return await decryptMessage(
      new Uint8Array(envelope.data),
      new Uint8Array(wrappedKey),
      new Uint8Array(envelope.iv),
      privateKey
    );
  } catch {
    return "[encrypted — decryption failed]";
  }
}

/**
 * Decrypts every envelope-shaped field of a row, so list views can cover all
 * encrypted fields on all rows with a single map().
 */
export async function decryptFieldsForSelf<T extends Record<string, unknown>>(
  row: T,
  userId: number,
  fields: ReadonlyArray<keyof T>
): Promise<T> {
  const out = { ...row };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === "string") {
      out[field] = (await decryptForSelf(value, userId)) as T[keyof T];
    }
  }
  return out;
}
