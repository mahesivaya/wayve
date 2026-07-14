// Wayve-to-Wayve email envelope, built in the sender's browser and POSTed to
// /api/email/send-internal as opaque ciphertext. The server stores it verbatim
// in `emails.body_encrypted` under its own at-rest layer, so this format must
// stay in sync with the Rust encryption module and with bodyUtils.ts, which
// recognises the `WAYVE_SECURE_V1` prefix. The inner `type` is
// `wayve_encrypted_multi` to distinguish it from the single-recipient
// `wayve_encrypted` shape emitted by the inbound encrypt-on-arrival path.
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
 * Every entry in `recipients` gets an RSA-OAEP-wrapped copy of the same fresh
 * AES key, indexed by user_id. The caller must include the sender if the
 * sender's own Sent copy should stay decryptable; this helper injects no one.
 * Throws on an empty recipient list or an unimportable public key.
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

  // One fresh AES key per message, never reused. Wrapping is per-recipient RSA,
  // but the bulk seal is a single AES-GCM pass so the body inflates only once.
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
