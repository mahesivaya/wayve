// Org-member login crypto.
//
// At login the backend returns `login_wrap: {iv, ct, salt, iterations}` for org
// members; personal users get null. The browser PBKDF2-derives an AES-GCM key
// from the entered password, decrypts the wrapped PKCS8 private key, and saves
// it into the same IndexedDB slot a personal user's key lives in, so every
// chat/notes/drive/email decrypt path finds it unchanged.

import {
  loadPrivateKey,
  savePrivateKey,
  savePublicKey,
} from "../crypto/keyStore";
import { unwrapPkcs8WithPbkdf2 } from "./envelopeCodec";
import type { NewLoginWrap } from "./api";

const PBKDF2_LOGIN_WRAP_ITERATIONS = 600_000;

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

// Produces the same envelope shape stored in member_login_wrapped_keys, so the
// iteration count here must match what the backend and the unwrap path expect.
async function wrapPkcs8ForLogin(
  pkcs8: ArrayBuffer,
  password: string
): Promise<NewLoginWrap> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.slice().buffer,
      iterations: PBKDF2_LOGIN_WRAP_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.slice().buffer },
    aesKey,
    pkcs8
  );
  return {
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(ct)),
    salt: bytesToB64(salt),
    iterations: PBKDF2_LOGIN_WRAP_ITERATIONS,
  };
}

// Re-wraps the already-cached private key under a new password for a
// self-service password change. Null means no key is cached on this device, so
// the backend has no member_login_wrapped_keys row to rotate and the plain
// password change suffices.
export async function buildLoginWrapForPassword(
  userId: number | null | undefined,
  email: string | null | undefined,
  newPassword: string
): Promise<NewLoginWrap | null> {
  const key = await loadPrivateKey(userId, email);
  if (!key) return null;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", key);
  return wrapPkcs8ForLogin(pkcs8, newPassword);
}

export type CachedKeys = {
  privateKey: CryptoKey;
  publicKeyBytes: ArrayBuffer;
};

// Deriving the SPKI locally avoids a round-trip to /api/me/public-key, which can
// race on first login after provisioning when the server may not have it yet.
//
// WebCrypto has no direct "give me the public half" call, so the portable path
// is to import as extractable RSA-OAEP, export to JWK, strip the private fields,
// and re-import.
async function derivePublicKeyFromPrivate(
  pkcs8: ArrayBuffer
): Promise<ArrayBuffer> {
  const priv = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", priv);
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
    ["encrypt"]
  );
  return crypto.subtle.exportKey("spki", pubKey);
}

export async function unwrapAndCacheMemberKeys(
  userId: number,
  email: string,
  password: string,
  loginWrap: NewLoginWrap
): Promise<CachedKeys> {
  const enc = new TextEncoder();
  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = await unwrapPkcs8WithPbkdf2(
      loginWrap.iv,
      loginWrap.ct,
      enc.encode(password),
      loginWrap.salt,
      loginWrap.iterations
    );
  } catch {
    throw new Error(
      "Could not unwrap your private key — password may be wrong or account corrupted."
    );
  }

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"]
  );
  const publicKeyBytes = await derivePublicKeyFromPrivate(pkcs8);

  // The same IndexedDB slots personal users use, so every existing decrypt path
  // finds the key without modification.
  await savePrivateKey(privateKey, userId, email);
  await savePublicKey(publicKeyBytes, userId, email);

  return { privateKey, publicKeyBytes };
}

// Unwrap the existing envelope with the OLD password and re-wrap it under the
// NEW one. The caller uploads the result alongside the new password.
export async function rewrapOwnLoginEnvelope(
  oldPassword: string,
  newPassword: string,
  oldWrap: NewLoginWrap
): Promise<NewLoginWrap> {
  const enc = new TextEncoder();
  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = await unwrapPkcs8WithPbkdf2(
      oldWrap.iv,
      oldWrap.ct,
      enc.encode(oldPassword),
      oldWrap.salt,
      oldWrap.iterations
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
    ["deriveKey"]
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
    ["encrypt"]
  );
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.slice().buffer },
    aesKey,
    pkcs8
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
