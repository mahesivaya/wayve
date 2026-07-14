// Owner and admin impersonation. The key-holder unwraps a member's escrow with
// the already-loaded org private key, recovering the member's PKCS8 private key,
// after which the existing decrypt paths work as if the key-holder were that
// member.
//
// The recovered key is held only in memory on the impersonation page and is
// never persisted to IndexedDB; closing the page wipes it.

import { getMemberEscrow } from "./api";
import { loadOrgPrivateKey } from "./orgKeyStore";
import { unwrapPkcs8WithRsaKey } from "./envelopeCodec";

export type ImpersonationContext = {
  memberUserId: number;
  // A decrypt-only RSA-OAEP key, passed to the existing decryption helpers in
  // place of the key they would otherwise load from IndexedDB.
  memberPrivateKey: CryptoKey;
};

// The escrow envelope stored in member_wrapped_keys.ct is the single-recipient
// shape and is self-describing, so the row's iv column is not meaningfully used.
async function unwrapWayveSecureV1Envelope(
  envelope: string,
  recipientPrivate: CryptoKey
): Promise<ArrayBuffer> {
  const newlineIdx = envelope.indexOf("\n");
  if (newlineIdx < 0) {
    throw new Error("Malformed member escrow envelope (missing newline).");
  }
  const prefix = envelope.slice(0, newlineIdx);
  if (prefix !== "WAYVE_SECURE_V1") {
    throw new Error(`Unsupported escrow envelope: ${prefix}`);
  }
  const body = JSON.parse(envelope.slice(newlineIdx + 1)) as {
    type: string;
    data: number[];
    key: number[];
    iv: number[];
  };
  if (body.type !== "wayve_encrypted") {
    throw new Error(`Unsupported envelope type: ${body.type}`);
  }
  const aesRaw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    recipientPrivate,
    new Uint8Array(body.key).slice().buffer
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    aesRaw,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(body.iv).slice().buffer },
    aesKey,
    new Uint8Array(body.data).slice().buffer
  );
}

export async function impersonateMember(
  orgId: number,
  callerUserId: number,
  memberUserId: number
): Promise<ImpersonationContext> {
  const orgPrivate = await loadOrgPrivateKey(orgId, callerUserId);
  if (!orgPrivate) {
    throw new Error(
      "Org master key not loaded on this device. Enter your recovery mnemonic at /organization/recovery-key."
    );
  }
  const { envelope } = await getMemberEscrow(orgId, memberUserId);
  const pkcs8 = await unwrapWayveSecureV1Envelope(envelope, orgPrivate);
  const memberPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"]
  );
  return { memberUserId, memberPrivateKey };
}

// Password-reset path: re-wrap the member's PKCS8 under PBKDF2(new password) into
// the `{iv, ct, salt, iterations}` envelope the backend reset handler accepts.
const PBKDF2_ITERATIONS = 600_000;

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function rewrapPkcs8UnderPassword(
  pkcs8: ArrayBuffer,
  password: string
): Promise<{ iv: string; ct: string; salt: string; iterations: number }> {
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
  return {
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(ct)),
    salt: bytesToB64(salt),
    iterations: PBKDF2_ITERATIONS,
  };
}

// Fetch the escrow, unwrap it, and re-wrap under the new password. The result is
// ready to upload to the backend reset endpoint.
export async function rewrapMemberForPasswordReset(
  orgId: number,
  callerUserId: number,
  memberUserId: number,
  newPassword: string
): Promise<{ iv: string; ct: string; salt: string; iterations: number }> {
  const orgPrivate = await loadOrgPrivateKey(orgId, callerUserId);
  if (!orgPrivate) {
    throw new Error(
      "Org master key not loaded on this device. Enter your recovery mnemonic at /organization/recovery-key."
    );
  }
  const { envelope } = await getMemberEscrow(orgId, memberUserId);
  const pkcs8 = await unwrapWayveSecureV1Envelope(envelope, orgPrivate);
  return rewrapPkcs8UnderPassword(pkcs8, newPassword);
}

// Re-exported for the password-change path, which needs the codec but never goes
// through escrow.
export { unwrapPkcs8WithRsaKey };
