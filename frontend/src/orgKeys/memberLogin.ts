// Org-member login crypto.
//
// At login the backend returns `login_wrap: {iv, ct, salt, iterations}`
// for org members (personal users get null). The browser:
//   1. PBKDF2-derives an AES-GCM key from the entered password.
//   2. Decrypts the wrapped PKCS8 private key.
//   3. Imports it and saves to the existing `wayve_keys` IndexedDB under
//      `privateKey:${userId}`, so chat/notes/drive/email decrypt paths
//      find it in the same place a personal user's key lives.
//
// Public key bytes can be reconstructed from the PKCS8 (the RSA key
// includes the modulus), but the existing code expects a separate
// `publicKey:${userId}` slot. We fetch the SPKI bytes from
// `users.public_key` via the same endpoint personal users use, then
// save both.

import { savePrivateKey, savePublicKey } from "../crypto/keyStore";
import { unwrapPkcs8WithPbkdf2 } from "./envelopeCodec";
import type { NewLoginWrap } from "./api";

export type CachedKeys = {
  privateKey: CryptoKey;
  publicKeyBytes: ArrayBuffer;
};

// Derive a public-key SPKI buffer from a PKCS8 private key by importing
// the private key with `extractable=true` and re-exporting the public
// component. Avoids a round-trip to /api/me/public-key when the server
// might not have it yet (race during first-login after provisioning).
async function derivePublicKeyFromPrivate(pkcs8: ArrayBuffer): Promise<ArrayBuffer> {
  // To export the public half we need to import with sign-like usages
  // first, but RSA-OAEP keys only export their public half through a
  // separate keypair derive. Easiest portable path: import as
  // extractable RSA-OAEP, export jwk, strip the private fields, import
  // back as SPKI. WebCrypto doesn't have a direct "give me the public
  // half" call.
  const priv = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  // Build a public-only JWK by keeping only the public fields.
  const pubJwk: JsonWebKey = {
    kty: jwk.kty,
    n: jwk.n,
    e: jwk.e,
    alg: jwk.alg,
    ext: true,
    key_ops: ["encrypt"],
  };
  const pubKey = await crypto.subtle.importKey(
    "jwk",
    pubJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"],
  );
  return crypto.subtle.exportKey("spki", pubKey);
}

export async function unwrapAndCacheMemberKeys(
  userId: number,
  email: string,
  password: string,
  loginWrap: NewLoginWrap,
): Promise<CachedKeys> {
  const enc = new TextEncoder();
  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = await unwrapPkcs8WithPbkdf2(
      loginWrap.iv,
      loginWrap.ct,
      enc.encode(password),
      loginWrap.salt,
      loginWrap.iterations,
    );
  } catch {
    throw new Error("Could not unwrap your private key — password may be wrong or account corrupted.");
  }

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"],
  );
  const publicKeyBytes = await derivePublicKeyFromPrivate(pkcs8);

  // Save to the SAME IndexedDB slots personal users use so every existing
  // decrypt code path (chat/notes/drive/email) finds it without
  // modification.
  await savePrivateKey(privateKey, userId, email);
  await savePublicKey(publicKeyBytes, userId, email);

  return { privateKey, publicKeyBytes };
}

// Used by the password-change flow: unwrap the existing wrap with the
// OLD password, re-wrap with the NEW password, return the new envelope
// ready to POST. Caller uploads it alongside the new password.
export async function rewrapOwnLoginEnvelope(
  oldPassword: string,
  newPassword: string,
  oldWrap: NewLoginWrap,
): Promise<NewLoginWrap> {
  const enc = new TextEncoder();
  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = await unwrapPkcs8WithPbkdf2(
      oldWrap.iv,
      oldWrap.ct,
      enc.encode(oldPassword),
      oldWrap.salt,
      oldWrap.iterations,
    );
  } catch {
    throw new Error("Current password is incorrect.");
  }
  const PBKDF2_ITERATIONS = 600_000;
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(newPassword),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.slice().buffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.slice().buffer },
    aesKey,
    pkcs8,
  );
  function bytesToB64(b: Uint8Array): string {
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s);
  }
  return {
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(ct)),
    salt: bytesToB64(salt),
    iterations: PBKDF2_ITERATIONS,
  };
}
