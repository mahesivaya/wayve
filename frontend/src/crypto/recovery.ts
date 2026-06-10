// Recovery flow: wrap the user's RSA private key with an AES-256-GCM key
// derived from their BIP-39 mnemonic. Only the resulting opaque ciphertext
// is sent to the server (in /api/me/wrapped-key). The mnemonic itself
// never leaves the device.
//
// Threat model assumption: the server is honest-but-curious. It can read
// the wrapped-key blob, but with PBKDF2 at 600,000 iterations and 256-bit
// entropy, brute-forcing the mnemonic is computationally infeasible.
// If you reduce the iteration count for "performance", you're trading
// real security for milliseconds. Don't.

import { savePrivateKey, savePublicKey } from "./keyStore";

const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 recommendation for SHA-256
const PBKDF2_SALT = new TextEncoder().encode("wayve-recovery-v1");

async function deriveWrappingKey(
  mnemonicEntropy: Uint8Array
): Promise<CryptoKey> {
  // PBKDF2 happens to be slow on purpose. Importing the entropy as raw
  // key material is the standard subtle-crypto pattern.
  const baseKey = await crypto.subtle.importKey(
    "raw",
    mnemonicEntropy.slice().buffer,
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: PBKDF2_SALT.slice().buffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false, // not extractable — never leaves WebCrypto
    ["wrapKey", "unwrapKey", "encrypt", "decrypt"]
  );
}

/**
 * Wire format for the wrapped key payload. Stored verbatim on the server,
 * uploaded as JSON. Versioned so a future migration (different KDF,
 * different cipher) can coexist with v1 keys during a transition.
 */
export type WrappedKeyEnvelope = {
  v: 1;
  iv: string; // base64, 12 bytes
  pub: string; // base64 of SPKI-exported public key (so a recovered device knows the matching pubkey without an extra round-trip)
  ct: string; // base64 of AES-GCM ciphertext over pkcs8 private key
};

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Encrypt the user's private + public keys under a mnemonic-derived key.
 * Returns the JSON-safe envelope that the backend stores verbatim.
 * Used by `recovery_mode = 'full'` users — the unwrap path reconstitutes
 * the real RSA private key on a new device.
 */
export async function wrapKeysForRecovery(
  privateKey: CryptoKey,
  publicKeyBytes: ArrayBuffer,
  mnemonicEntropy: Uint8Array
): Promise<WrappedKeyEnvelope> {
  const exportedPrivate = await crypto.subtle.exportKey("pkcs8", privateKey);
  const wrappingKey = await deriveWrappingKey(mnemonicEntropy);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.slice().buffer },
    wrappingKey,
    exportedPrivate
  );
  return {
    v: 1,
    iv: bytesToB64(iv),
    pub: bytesToB64(new Uint8Array(publicKeyBytes)),
    ct: bytesToB64(new Uint8Array(ciphertext)),
  };
}

/**
 * Build a credential-only envelope for `recovery_mode = 'password_only'`
 * users. The wrapped plaintext is 32 random bytes — meaningless on its
 * own, but successfully decrypting it proves the user holds the
 * mnemonic. That's all `/recover-with-mnemonic` needs to authorize a
 * password reset.
 *
 * Crucially, the user's real RSA private key never leaves the device in
 * this mode. Server compromise leaks only the credential blob, which
 * can be brute-forced into a mnemonic but yields no decryption material
 * for the user's chat/notes/files.
 */
export async function wrapCredentialForRecovery(
  publicKeyBytes: ArrayBuffer,
  mnemonicEntropy: Uint8Array
): Promise<WrappedKeyEnvelope> {
  // 32 random bytes is enough to make the ciphertext non-empty and the
  // AES-GCM auth tag meaningful. The contents are never read again.
  const credentialPlaintext = crypto.getRandomValues(new Uint8Array(32));
  const wrappingKey = await deriveWrappingKey(mnemonicEntropy);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.slice().buffer },
    wrappingKey,
    credentialPlaintext.slice().buffer
  );
  return {
    v: 1,
    iv: bytesToB64(iv),
    // Include the device's public key so the server has the SPKI on
    // record (matches the `full` shape — backend treats both rows
    // identically). The pubkey is also stored on `users.public_key`
    // via /api/save-public-key; this is a convenience copy.
    pub: bytesToB64(new Uint8Array(publicKeyBytes)),
    ct: bytesToB64(new Uint8Array(ciphertext)),
  };
}

/**
 * Reverse of `wrapKeysForRecovery`. On success, saves both keys into
 * IndexedDB under the given `userId` so the rest of the app finds them
 * exactly where the normal first-login flow puts them. Throws on
 * tampered or wrong-mnemonic envelopes (AES-GCM auth tag failure).
 */
export async function unwrapKeysFromRecovery(
  envelope: WrappedKeyEnvelope,
  mnemonicEntropy: Uint8Array,
  userId: number,
  email?: string | null
): Promise<{ privateKey: CryptoKey; publicKeyBytes: ArrayBuffer }> {
  if (envelope.v !== 1) {
    throw new Error(`Unsupported wrapped-key version: ${envelope.v}`);
  }
  const wrappingKey = await deriveWrappingKey(mnemonicEntropy);
  const iv = b64ToBytes(envelope.iv);
  const ct = b64ToBytes(envelope.ct);
  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.slice().buffer },
      wrappingKey,
      ct.slice().buffer
    );
  } catch {
    // AES-GCM auth tag mismatch — wrong mnemonic, or the blob was tampered with.
    throw new Error(
      "Could not decrypt recovery payload — please double-check your 24 words."
    );
  }

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"]
  );
  const publicKeyBytes = b64ToBytes(envelope.pub).slice().buffer;

  // Persist locally so chat/notes/drive/attachments all find the keypair
  // in the same place a normal first-login flow puts it. Email alias is
  // also written so a later userId reshuffle (dev DB reset) doesn't
  // orphan these keys.
  await savePrivateKey(privateKey, userId, email);
  await savePublicKey(publicKeyBytes, userId, email);

  return { privateKey, publicKeyBytes };
}
