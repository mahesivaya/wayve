// Secure-send magic-link crypto. Everything happens in the browser: the
// passphrase never touches the wire. A random per-message DEK seals the body
// with AES-256-GCM; that DEK is wrapped under a KEK derived from
// PBKDF2-HMAC-SHA256(passphrase, random salt, 600k iters). The server only ever
// sees ciphertext, wrapped key, and salt. The recipient repeats the derivation
// with the passphrase shared out-of-band.

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_SALT_BYTES = 16;
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveWrappingKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  // Non-extractable (`false`) so a buggy caller can't log the KEK.
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.slice().buffer, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export type SecureSendBundle = {
  ciphertext: string; // base64 AES-GCM body
  iv: string; // base64 12-byte body nonce
  wrapped_key: string; // base64 AES-GCM(KEK)-wrapped DEK
  salt: string; // base64 16-byte PBKDF2 salt
  pbkdf2_iterations: number;
};

/**
 * Seals a body under a passphrase the sender shares out-of-band. The result is
 * POSTed to /api/email/send-secure verbatim.
 */
export async function sealSecureMessage(
  plaintextBody: string,
  passphrase: string
): Promise<SecureSendBundle> {
  if (passphrase.length < 6) {
    // PBKDF2 can't rescue a one-character passphrase.
    throw new Error("Passphrase must be at least 6 characters");
  }

  // The salt is per-message, so the same passphrase yields a different KEK on
  // every send and two messages never share a ciphertext.
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));

  const dek = crypto.getRandomValues(new Uint8Array(AES_KEY_BYTES));
  const bodyIv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));

  // The wrap uses an all-zero nonce, which is safe only because the KEK is
  // unique per message (random salt → different KEK), so the (key, nonce) pair
  // is never reused.
  const kek = await deriveWrappingKey(passphrase, salt, PBKDF2_ITERATIONS);
  const wrapIv = new Uint8Array(AES_IV_BYTES);
  const wrappedDek = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: wrapIv.slice().buffer },
    kek,
    dek.slice().buffer
  );

  const dekCryptoKey = await crypto.subtle.importKey(
    "raw",
    dek.slice().buffer,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bodyIv.slice().buffer },
    dekCryptoKey,
    enc.encode(plaintextBody).slice().buffer
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(bodyIv),
    wrapped_key: bytesToBase64(new Uint8Array(wrappedDek)),
    salt: bytesToBase64(salt),
    pbkdf2_iterations: PBKDF2_ITERATIONS,
  };
}

export type ServerSecureMessage = {
  token: string;
  sender_email: string;
  subject: string;
  ciphertext: string;
  iv: string;
  wrapped_key: string;
  salt: string;
  pbkdf2_iterations: number;
  expires_at: string;
  created_at: string;
};

/**
 * Reverse of `sealSecureMessage`. Throws on an auth-tag failure (wrong
 * passphrase or corrupted ciphertext); call sites should show the message
 * verbatim to the user.
 */
export async function openSecureMessage(
  envelope: ServerSecureMessage,
  passphrase: string
): Promise<string> {
  const salt = base64ToBytes(envelope.salt);
  const wrappedKeyBytes = base64ToBytes(envelope.wrapped_key);
  const bodyIv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);

  // A wrong passphrase still derives a key here, just not the right one. The
  // AES-GCM auth tag below is what actually catches the mismatch.
  const kek = await deriveWrappingKey(
    passphrase,
    salt,
    envelope.pbkdf2_iterations
  );

  let dekBytes: ArrayBuffer;
  try {
    const wrapIv = new Uint8Array(AES_IV_BYTES);
    dekBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: wrapIv.slice().buffer },
      kek,
      wrappedKeyBytes.slice().buffer
    );
  } catch {
    // GCM auth-tag mismatch is the wrong-passphrase signal.
    throw new Error(
      "Couldn't unlock this message. Double-check the passphrase the sender shared with you."
    );
  }

  const dekCryptoKey = await crypto.subtle.importKey(
    "raw",
    dekBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  try {
    const plaintextBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bodyIv.slice().buffer },
      dekCryptoKey,
      ciphertext.slice().buffer
    );
    return dec.decode(plaintextBytes);
  } catch {
    // Unreachable unless the ciphertext was tampered with, since the wrap step
    // already succeeded. Surface a clean message, not a raw DOMException.
    throw new Error(
      "Message body failed to decrypt — the ciphertext may be corrupted."
    );
  }
}
