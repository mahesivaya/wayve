// Owner / admin impersonation flow. The key-holder uses their already-
// loaded org private key to unwrap a member's escrow, getting back the
// member's PKCS8 private key. From there the existing crypto code paths
// (chat, notes, drive, email) decrypt as if the key-holder were the
// member.
//
// The recovered member private key is held only in a scoped JS variable
// in the impersonation page — never persisted to IndexedDB. Closing the
// page wipes it from memory.

import { getMemberEscrow } from "./api";
import { loadOrgPrivateKey } from "./orgKeyStore";
import { unwrapPkcs8WithRsaKey } from "./envelopeCodec";

export type ImpersonationContext = {
  memberUserId: number;
  // RSA-OAEP-decrypt-only CryptoKey. Pass to existing decryption helpers
  // (selfEncrypt.ts:decryptForSelf, chat/e2ee.ts:decryptChatContent,
  // emails/bodyUtils.ts:decryptWayveBodyIfNeeded, etc.) in place of the
  // key those helpers usually load from IndexedDB.
  memberPrivateKey: CryptoKey;
};

// The escrow envelope stored in member_wrapped_keys.ct is exactly the
// `WAYVE_SECURE_V1` single-recipient shape (no iv column meaningfully
// used — the envelope is self-describing). Parse it and unwrap with
// the org private key.
async function unwrapWayveSecureV1Envelope(
  envelope: string,
  recipientPrivate: CryptoKey,
): Promise<ArrayBuffer> {
  // Format: "WAYVE_SECURE_V1\n{json with type/data/key/iv}"
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
    new Uint8Array(body.key).slice().buffer,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    aesRaw,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(body.iv).slice().buffer },
    aesKey,
    new Uint8Array(body.data).slice().buffer,
  );
}

export async function impersonateMember(
  orgId: number,
  callerUserId: number,
  memberUserId: number,
): Promise<ImpersonationContext> {
  const orgPrivate = await loadOrgPrivateKey(orgId, callerUserId);
  if (!orgPrivate) {
    throw new Error(
      "Org master key not loaded on this device. Enter your recovery mnemonic at /organization/recovery-key.",
    );
  }
  const { envelope } = await getMemberEscrow(orgId, memberUserId);
  const pkcs8 = await unwrapWayveSecureV1Envelope(envelope, orgPrivate);
  const memberPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"],
  );
  return { memberUserId, memberPrivateKey };
}

// Reset path: re-wrap the member's PKCS8 under PBKDF2(new_password) and
// return the `{iv, ct, salt, iterations}` envelope shape the backend
// reset handler accepts. Caller posts the result via resetMemberPassword.
const PBKDF2_ITERATIONS = 600_000;

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function rewrapPkcs8UnderPassword(
  pkcs8: ArrayBuffer,
  password: string,
): Promise<{ iv: string; ct: string; salt: string; iterations: number }> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
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
  return {
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(ct)),
    salt: bytesToB64(salt),
    iterations: PBKDF2_ITERATIONS,
  };
}

// Same helper used in two flows: fetch escrow → unwrap → re-wrap under
// the new password. Returned envelope is ready to upload to the backend
// reset endpoint.
export async function rewrapMemberForPasswordReset(
  orgId: number,
  callerUserId: number,
  memberUserId: number,
  newPassword: string,
): Promise<{ iv: string; ct: string; salt: string; iterations: number }> {
  const orgPrivate = await loadOrgPrivateKey(orgId, callerUserId);
  if (!orgPrivate) {
    throw new Error(
      "Org master key not loaded on this device. Enter your recovery mnemonic at /organization/recovery-key.",
    );
  }
  const { envelope } = await getMemberEscrow(orgId, memberUserId);
  const pkcs8 = await unwrapWayveSecureV1Envelope(envelope, orgPrivate);
  return rewrapPkcs8UnderPassword(pkcs8, newPassword);
}

// Re-export so other modules can use the codec without importing it
// directly — handy for the password-change path which calls this
// helper without going through escrow.
export { unwrapPkcs8WithRsaKey };
