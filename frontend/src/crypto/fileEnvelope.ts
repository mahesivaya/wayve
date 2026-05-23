// Binary envelope for E2E-encrypted file blobs (drive, email attachments).
//
// Why a binary format rather than the JSON `WAYVE_SECURE_V1` shape that
// notes / chat use:
//   - JSON-encoding raw bytes as a number array roughly triples size.
//     For a 50 MB drive upload that's a 150 MB request body.
//   - File uploads already go through multipart/form-data which preserves
//     binary bytes natively — no need to base64 anything.
//
// Layout (all integers big-endian):
//   bytes  0..4   magic     "WV1\0"   (0x57 0x56 0x31 0x00)
//   bytes  4..6   version   u16 = 1
//   bytes  6..18  iv        12 bytes (AES-GCM nonce)
//   bytes  18..22 wlen      u32 length of wrapped AES key
//   bytes  22..22+wlen      wrapped AES key (RSA-OAEP ciphertext)
//   bytes  rest             AES-GCM ciphertext (file body + 16-byte tag)
//
// The header is ~280 bytes for an RSA-2048 wrap. The wrapped key holds
// only one recipient (the file owner); to support sharing a file later,
// we extend the format with multiple `(user_id, wrapped_key)` entries —
// see TODO at end. Phase 1 doesn't ship sharing.

import { loadPrivateKey, loadPublicKey } from "./keyStore";

const MAGIC = new Uint8Array([0x57, 0x56, 0x31, 0x00]); // "WV1\0"
const VERSION = 1;
const IV_LEN = 12;

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

function writeU16BE(value: number): Uint8Array {
  const out = new Uint8Array(2);
  out[0] = (value >>> 8) & 0xff;
  out[1] = value & 0xff;
  return out;
}

function writeU32BE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

function readU16BE(bytes: Uint8Array, off: number): number {
  return (bytes[off] << 8) | bytes[off + 1];
}

function readU32BE(bytes: Uint8Array, off: number): number {
  return (
    (bytes[off] * 0x1000000) +
    ((bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3])
  );
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Encrypt a Blob/File for storage on the server. Returns a Blob in the
 * WV1 binary envelope format — opaque bytes the server stores verbatim.
 *
 * @param blob       The plaintext file body.
 * @param userId     The owner's user_id (we wrap the AES key with their
 *                   public key so only they can decrypt the result).
 * @param mimeType   Optional MIME type override; not part of the envelope.
 *                   The caller is responsible for storing/restoring it
 *                   alongside the encrypted blob (e.g. as a separate
 *                   form field or DB column).
 */
export async function encryptBlobForSelf(
  blob: Blob,
  userId: number,
  mimeType?: string
): Promise<Blob> {
  const publicKey = await importOwnPublicKey(userId);
  const plaintext = await blob.arrayBuffer();

  // Generate a fresh AES key for this one file — never reused.
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv.slice().buffer },
      aesKey,
      plaintext
    )
  );

  // Wrap the AES key with the user's RSA public key.
  const rawAes = await crypto.subtle.exportKey("raw", aesKey);
  const wrappedKey = new Uint8Array(
    await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawAes)
  );

  const envelope = concatBytes([
    MAGIC,
    writeU16BE(VERSION),
    iv,
    writeU32BE(wrappedKey.length),
    wrappedKey,
    ciphertext,
  ]);

  // `.slice().buffer` produces a guaranteed ArrayBuffer (not the union
  // ArrayBufferLike that TS infers for Uint8Array) — matches the strict
  // BlobPart typing used in newer @types/node + lib.dom.
  return new Blob([envelope.slice().buffer], {
    type: mimeType ?? "application/octet-stream",
  });
}

/**
 * Quick header check — used by the download path to decide whether to
 * treat the response as an envelope or as a pre-E2E plaintext file.
 */
export function looksLikeEnvelope(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 6 &&
    bytes[0] === MAGIC[0] &&
    bytes[1] === MAGIC[1] &&
    bytes[2] === MAGIC[2] &&
    bytes[3] === MAGIC[3]
  );
}

/**
 * Parse and decrypt a WV1 envelope downloaded from the server. Returns
 * a Blob with the original file contents; caller picks the MIME type
 * (we don't carry it in-envelope to keep the format minimal).
 *
 * Throws if the envelope is malformed, the version isn't recognized,
 * or the user's local private key can't decrypt the wrapped key — i.e.
 * the only honest failure modes. Don't catch-and-rethrow here; the UI
 * should surface "couldn't decrypt this file" verbatim.
 */
export async function decryptBlobForSelf(
  encrypted: ArrayBuffer | Uint8Array,
  userId: number,
  outputMime?: string
): Promise<Blob> {
  const bytes = encrypted instanceof Uint8Array
    ? encrypted
    : new Uint8Array(encrypted);

  if (!looksLikeEnvelope(bytes)) {
    throw new Error("File is not an encrypted envelope");
  }

  let offset = 4;
  const version = readU16BE(bytes, offset);
  offset += 2;
  if (version !== VERSION) {
    throw new Error(`Unsupported envelope version: ${version}`);
  }

  const iv = bytes.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;

  const wrappedLen = readU32BE(bytes, offset);
  offset += 4;
  if (wrappedLen <= 0 || wrappedLen > 1024) {
    // 1 KB cap: RSA-2048 wrap is 256B, RSA-4096 would be 512B.
    throw new Error("Malformed envelope: implausible wrapped-key length");
  }

  const wrappedKey = bytes.subarray(offset, offset + wrappedLen);
  offset += wrappedLen;

  const ciphertext = bytes.subarray(offset);

  const privateKey = await loadPrivateKey(userId);
  if (!privateKey) {
    throw new Error("No private key on this device — restore from your recovery phrase first.");
  }

  const rawAes = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    wrappedKey.slice().buffer
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawAes,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.slice().buffer },
    aesKey,
    ciphertext.slice().buffer
  );

  return new Blob([plaintext], {
    type: outputMime ?? "application/octet-stream",
  });
}

// TODO(sharing): to extend this envelope for shared files, replace the
// single (wlen + wrappedKey) with a small recipient table:
//   bytes wlen u16 = number of entries
//   entries[]: { user_id: u32, key_len: u16, wrapped_key: bytes }
// Bump VERSION to 2 and add a parse branch in decryptBlobForSelf.
