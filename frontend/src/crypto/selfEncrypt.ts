// Self-encryption helpers for owner-only surfaces (notes today; drive +
// attachments to come). Wraps content in the same WAYVE_SECURE_V1 envelope
// shape that chat uses, but with only one recipient (the user themselves).
//
// Why mirror the chat envelope instead of inventing a new format?
//   - One decoder path covers chat, notes, drive, attachments.
//   - When we later add shared notes / shared drive folders, the "keys"
//     dict already supports multi-recipient — just add more entries.
//   - Server-side detection ("does this row start with WAYVE_SECURE_V1?")
//     is one prefix check across all features.

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
 * Encrypt `plaintext` with a fresh AES-256-GCM key, then wrap that AES
 * key with the user's own RSA public key. Result is a WAYVE_SECURE_V1
 * envelope string suitable for storing in the notes/title columns
 * verbatim. Decrypt later with `decryptForSelf`.
 */
export async function encryptForSelf(
  plaintext: string,
  userId: number
): Promise<string> {
  if (plaintext.length === 0) {
    // Don't waste an AES key on empty strings — and an empty-string
    // envelope would be visually indistinguishable from an empty cell.
    // Callers should treat "" as "no content" and skip encryption.
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
 * Detect whether a stored string is a self-encrypted envelope. Used to
 * preserve backward compatibility with plaintext rows that pre-date this
 * feature: any string without the prefix is returned as-is.
 */
export function isSelfEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(SELF_PREFIX);
}

/**
 * Decrypt a WAYVE_SECURE_V1 envelope produced by `encryptForSelf`. If
 * the input isn't an envelope, returns it unchanged (so callers don't
 * have to branch). On any decryption error returns a clear placeholder
 * string the UI can render directly rather than throwing — losing one
 * note shouldn't crash the whole list.
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
 * Batch helper — decrypts each field of an object that's an envelope.
 * Used by list-views (notes index, drive list) so a single map() call
 * covers every encrypted field on every row.
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
