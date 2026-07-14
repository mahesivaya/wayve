// Recovery flow: wrap the user's RSA private key with an AES-256-GCM key derived
// from their BIP-39 mnemonic. Only the opaque ciphertext is sent to the server
// (/api/me/wrapped-key); the mnemonic itself never leaves the device.
//
// The threat model assumes an honest-but-curious server. It can read the
// wrapped-key blob, but at 600,000 PBKDF2 iterations over 256-bit entropy,
// brute-forcing the mnemonic is infeasible. Lowering the iteration count for
// "performance" trades real security for milliseconds. Don't.

import { savePrivateKey, savePublicKey } from "./keyStore";

const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 recommendation for SHA-256
const PBKDF2_SALT = new TextEncoder().encode("wayve-recovery-v1");

async function deriveWrappingKey(
  mnemonicEntropy: Uint8Array
): Promise<CryptoKey> {
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
 * Wire format for the wrapped key payload, uploaded as JSON and stored verbatim.
 * Versioned so a future KDF or cipher change can coexist with v1 keys.
 */
export type WrappedKeyEnvelope = {
  v: 1;
  iv: string; // base64, 12 bytes
  pub: string; // base64 SPKI public key, so a recovered device needs no extra round-trip
  ct: string; // base64 AES-GCM ciphertext over the pkcs8 private key
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
 * Encrypt the user's keypair under a mnemonic-derived key. The unwrap path
 * reconstitutes the real RSA private key on a new device, so this envelope is
 * the only thing standing between a lost device and lost data.
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
 * Credential-only envelope for `recovery_mode = 'password_only'` users. The
 * wrapped plaintext is 32 random bytes, meaningless on its own, but decrypting
 * it proves the user holds the mnemonic — all `/recover-with-mnemonic` needs to
 * authorize a password reset.
 *
 * The real RSA private key never leaves the device in this mode, so a server
 * compromise leaks only this blob and no decryption material for the user's
 * chat, notes or files.
 */
export async function wrapCredentialForRecovery(
  publicKeyBytes: ArrayBuffer,
  mnemonicEntropy: Uint8Array
): Promise<WrappedKeyEnvelope> {
  // Enough bytes to make the ciphertext non-empty and the auth tag meaningful.
  // The contents are never read again.
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
    // Carry the public key so this row matches the `full` shape and the backend
    // can treat both identically. It duplicates `users.public_key`.
    pub: bytesToB64(new Uint8Array(publicKeyBytes)),
    ct: bytesToB64(new Uint8Array(ciphertext)),
  };
}

/**
 * Reverse of `wrapKeysForRecovery`. Saves both keys into IndexedDB under
 * `userId`, where the rest of the app expects to find them. Throws on a tampered
 * or wrong-mnemonic envelope, which surfaces as an AES-GCM auth tag failure.
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
    // Auth tag mismatch: wrong mnemonic, or the blob was tampered with.
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

  // Persist locally so chat, notes, drive and attachments all find the keypair
  // where a normal first login would have put it. The email alias is written too,
  // so a later userId reshuffle (a dev DB reset) doesn't orphan these keys.
  await savePrivateKey(privateKey, userId, email);
  await savePublicKey(publicKeyBytes, userId, email);

  return { privateKey, publicKeyBytes };
}
