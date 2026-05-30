// Plan A Phase 3 — Secure-send magic link crypto helpers.
//
// All the heavy lifting happens in the browser. The sender's
// passphrase NEVER touches the wire — it's used to derive a wrapping
// key locally, with a per-message random salt that travels with the
// ciphertext. The server stores opaque ciphertext + wrapped key +
// salt; the recipient repeats the derivation with the passphrase
// shared out-of-band to decrypt.
//
// Crypto:
//   * KDF:      PBKDF2-HMAC-SHA256, 600,000 iters (same as recovery)
//   * KEK:      32 bytes derived from PBKDF2(passphrase, salt)
//   * DEK:      32 random bytes per message
//   * Body seal: AES-256-GCM(DEK, iv, body)
//   * Wrap:     AES-256-GCM(KEK, fixed-zero-iv, DEK)
//                 — KEK is derived freshly per-message so a fixed
//                   nonce is safe (PBKDF2(passphrase, salt) is unique
//                   per send because salt is random)

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_SALT_BYTES = 16;
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
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
  iterations: number,
): Promise<CryptoKey> {
  // Import the raw passphrase bytes as PBKDF2 input material, then
  // derive an AES-GCM key. `false` makes the derived key
  // non-extractable so a buggy caller can't accidentally log the KEK.
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.slice().buffer, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export type SecureSendBundle = {
  ciphertext: string; // base64 AES-GCM body
  iv: string;         // base64 12-byte body nonce
  wrapped_key: string; // base64 AES-GCM(KEK)-wrapped DEK
  salt: string;        // base64 16-byte PBKDF2 salt
  pbkdf2_iterations: number;
};

/**
 * Build a secure-send bundle from a plaintext body and a passphrase
 * the user will share with the recipient out-of-band. Returns the
 * four pieces to POST to /api/email/send-secure verbatim.
 */
export async function sealSecureMessage(
  plaintextBody: string,
  passphrase: string,
): Promise<SecureSendBundle> {
  if (passphrase.length < 6) {
    // PBKDF2 alone can't rescue a one-character passphrase. Forcing
    // a minimum here is the cheapest UX defence against accidental
    // empty/weak inputs.
    throw new Error("Passphrase must be at least 6 characters");
  }

  // 1. Per-message random salt — same passphrase produces a different
  //    KEK every send, so two messages to the same recipient with the
  //    same passphrase have unrelated ciphertexts.
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));

  // 2. Fresh DEK + nonce for the body.
  const dek = crypto.getRandomValues(new Uint8Array(AES_KEY_BYTES));
  const bodyIv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));

  // 3. Derive KEK from passphrase + salt; wrap the DEK with it. We use
  //    a fixed zero nonce for the wrap because the KEK is unique per
  //    message (different salt → different KEK), so the (KEK, fixed
  //    nonce) pair is also unique.
  const kek = await deriveWrappingKey(passphrase, salt, PBKDF2_ITERATIONS);
  const wrapIv = new Uint8Array(AES_IV_BYTES); // all-zero, see above
  const wrappedDek = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: wrapIv.slice().buffer },
    kek,
    dek.slice().buffer,
  );

  // 4. Encrypt the body with the DEK + body nonce. Standard AES-GCM.
  const dekCryptoKey = await crypto.subtle.importKey(
    "raw",
    dek.slice().buffer,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bodyIv.slice().buffer },
    dekCryptoKey,
    enc.encode(plaintextBody).slice().buffer,
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
 * Reverse of `sealSecureMessage`. Given a server response and the
 * recipient's passphrase, recover the plaintext body. Throws on auth
 * tag failure (wrong passphrase / corrupted ciphertext) — call sites
 * should surface the message verbatim to the user.
 */
export async function openSecureMessage(
  envelope: ServerSecureMessage,
  passphrase: string,
): Promise<string> {
  const salt = base64ToBytes(envelope.salt);
  const wrappedKeyBytes = base64ToBytes(envelope.wrapped_key);
  const bodyIv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);

  // Repeat the sender's derivation with the same salt + iteration
  // count. If the passphrase is wrong, this still produces *a* key —
  // just not the right one — so the AES-GCM auth tag verification
  // below is what actually catches the mismatch.
  const kek = await deriveWrappingKey(
    passphrase,
    salt,
    envelope.pbkdf2_iterations,
  );

  let dekBytes: ArrayBuffer;
  try {
    const wrapIv = new Uint8Array(AES_IV_BYTES);
    dekBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: wrapIv.slice().buffer },
      kek,
      wrappedKeyBytes.slice().buffer,
    );
  } catch {
    // GCM auth-tag mismatch is the wrong-passphrase signal.
    throw new Error(
      "Couldn't unlock this message. Double-check the passphrase the sender shared with you.",
    );
  }

  const dekCryptoKey = await crypto.subtle.importKey(
    "raw",
    dekBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  try {
    const plaintextBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bodyIv.slice().buffer },
      dekCryptoKey,
      ciphertext.slice().buffer,
    );
    return dec.decode(plaintextBytes);
  } catch {
    // Should be impossible if the wrap step succeeded — but a tampered
    // ciphertext could still fail here. Surface a clean message rather
    // than the underlying DOMException.
    throw new Error("Message body failed to decrypt — the ciphertext may be corrupted.");
  }
}
