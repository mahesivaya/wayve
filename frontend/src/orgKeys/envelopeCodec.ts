// Shared codec for the (iv, ct) envelope shape that the org-key flows
// use to wrap a PKCS8 private key under EITHER (a) the org pubkey
// [RSA-OAEP + AES-GCM hybrid, ct holds JSON {wrapped_aes, body}] OR
// (b) a PBKDF2-derived key [AES-GCM directly, ct holds raw ciphertext].
//
// The wire shape is `{iv: base64, ct: base64}` in both cases — the
// difference is in what the ct decodes to. Callers pick the right
// unwrap helper based on which key column the envelope came from.

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function decodeBase64(s: string): Uint8Array {
  return b64ToBytes(s);
}

// Unwrap a PKCS8 private key from a `{iv, ct}` envelope that was
// produced by RSA-OAEP-wrapping an AES key + AES-GCM-encrypting the
// PKCS8. The recipient holds the matching RSA private key.
export async function unwrapPkcs8WithRsaKey(
  iv: string,
  ct: string,
  recipientPrivate: CryptoKey,
): Promise<ArrayBuffer> {
  const ivBytes = decodeBase64(iv);
  const innerJsonBytes = decodeBase64(ct);
  const innerJson = new TextDecoder().decode(innerJsonBytes);
  const inner = JSON.parse(innerJson) as {
    wrapped_aes: number[];
    body: number[];
  };
  const wrappedAes = new Uint8Array(inner.wrapped_aes);
  const body = new Uint8Array(inner.body);
  const aesRaw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    recipientPrivate,
    wrappedAes.slice().buffer,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    aesRaw,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes.slice().buffer },
    aesKey,
    body.slice().buffer,
  );
}

// Unwrap a PKCS8 private key from a `{iv, ct, pbkdf2_salt, iterations}`
// envelope that was produced by PBKDF2-deriving an AES key and
// AES-GCM-encrypting the PKCS8 directly. `inputMaterial` is whatever
// PBKDF2 hashes — mnemonic entropy for the org bootstrap path, or the
// raw password bytes for the member-login path.
export async function unwrapPkcs8WithPbkdf2(
  iv: string,
  ct: string,
  inputMaterial: BufferSource,
  saltB64: string,
  iterations: number,
): Promise<ArrayBuffer> {
  const ivBytes = decodeBase64(iv);
  const ctBytes = decodeBase64(ct);
  const salt = decodeBase64(saltB64);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    inputMaterial,
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.slice().buffer,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes.slice().buffer },
    aesKey,
    ctBytes.slice().buffer,
  );
}

// Helper for testing parity with the backend: build the same `{iv, ct}`
// envelope that orgKeypair.bootstrapOrgMasterKey emits when wrapping a
// PKCS8 under a recipient RSA pubkey. Used by ownerImpersonate when it
// needs to re-wrap (e.g., add a new key-holder) AND by unit tests.
export async function wrapPkcs8ToRsaPubkey(
  pkcs8: ArrayBuffer,
  recipientSpkiBytes: ArrayBuffer,
): Promise<{ iv: string; ct: string }> {
  const recipientPub = await crypto.subtle.importKey(
    "spki",
    recipientSpkiBytes,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  const aesRaw = await crypto.subtle.exportKey("raw", aesKey);
  const wrappedAes = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    recipientPub,
    aesRaw,
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.slice().buffer },
    aesKey,
    pkcs8,
  );
  const inner = JSON.stringify({
    wrapped_aes: Array.from(new Uint8Array(wrappedAes)),
    body: Array.from(new Uint8Array(ct)),
  });
  let ivBin = "";
  for (const b of iv) ivBin += String.fromCharCode(b);
  return { iv: btoa(ivBin), ct: btoa(unescape(encodeURIComponent(inner))) };
}
