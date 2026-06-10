// Plan A Phase 2 — Wayve-to-Wayve email envelope.
//
// Multi-recipient `WAYVE_SECURE_V1` envelope produced entirely in the
// sender's browser and POSTed to /api/email/send-internal as opaque
// ciphertext. The server stores it verbatim in `emails.body_encrypted`
// for every recipient (and the sender's Sent copy). Wire shape mirrors
// the chat E2E envelope (`WAYVE_CHAT_E2E_V1` in
// frontend/src/chat/e2ee.ts) with two differences:
//
//   * outer prefix is `WAYVE_SECURE_V1` so bodyUtils.ts already
//     recognises it as a wayve-encrypted email body;
//   * inner `type` is `wayve_encrypted_multi` to disambiguate from the
//     single-recipient `wayve_encrypted` shape that Phase 1's inbound
//     encrypt-on-arrival path emits.
//
//   WAYVE_SECURE_V1
//   { "type": "wayve_encrypted_multi",
//     "data": [...AES-GCM ciphertext bytes...],
//     "iv":   [...12 bytes...],
//     "keys": { "<userId>": [...RSA-OAEP-wrapped AES key bytes...] } }

const WAYVE_INTERNAL_PREFIX = "WAYVE_SECURE_V1\n";

export type InternalRecipientKey = {
  userId: number;
  publicKeyBytes: number[];
};

export type WayveEncryptedMultiEnvelope = {
  type: "wayve_encrypted_multi";
  data: number[];
  iv: number[];
  keys: Record<string, number[]>;
};

const toArrayBuffer = (
  input: number[] | ArrayBuffer | Uint8Array
): ArrayBuffer => {
  if (input instanceof ArrayBuffer) return input;
  if (input instanceof Uint8Array) return input.slice().buffer;
  return new Uint8Array(input).slice().buffer;
};

const importRecipientPublicKey = (bytes: number[] | ArrayBuffer | Uint8Array) =>
  crypto.subtle.importKey(
    "spki",
    toArrayBuffer(bytes),
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"]
  );

/**
 * Build a multi-recipient envelope around `plaintextBody`. Every entry
 * in `recipients` gets an RSA-OAEP-wrapped copy of the same fresh AES
 * key indexed by their user_id. Include the sender in `recipients` if
 * the sender should be able to decrypt their own Sent copy — the
 * caller is responsible for that decision; this helper does not
 * silently inject anyone.
 *
 * Throws on an empty recipient list (a meaningless envelope), or if
 * any public key fails to import (caller should pre-validate keys
 * before reaching this function).
 */
export async function buildInternalEnvelope(
  plaintextBody: string,
  recipients: InternalRecipientKey[]
): Promise<string> {
  if (recipients.length === 0) {
    throw new Error(
      "buildInternalEnvelope: at least one recipient is required"
    );
  }

  // Fresh AES-256-GCM key for THIS message only — never reused. The
  // wrapping keys are RSA per-recipient, but the bulk encryption is a
  // single AES-GCM seal so the message body only inflates once.
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(plaintextBody)
  );
  const rawAes = await crypto.subtle.exportKey("raw", aesKey);

  const wrappedKeys: Record<string, number[]> = {};
  for (const recipient of recipients) {
    const pubKey = await importRecipientPublicKey(recipient.publicKeyBytes);
    const wrapped = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      pubKey,
      rawAes
    );
    wrappedKeys[String(recipient.userId)] = Array.from(new Uint8Array(wrapped));
  }

  const envelope: WayveEncryptedMultiEnvelope = {
    type: "wayve_encrypted_multi",
    data: Array.from(new Uint8Array(ciphertext)),
    iv: Array.from(iv),
    keys: wrappedKeys,
  };

  return `${WAYVE_INTERNAL_PREFIX}${JSON.stringify(envelope)}`;
}
