import { decryptMessage } from "../crypto/crypto";
import { loadPrivateKey } from "../crypto/keyStore";
import type { WayveEncryptedBody } from "./types";

const WAYVE_SECURE_PREFIX = "WAYVE_SECURE_V1";

export function normalizeEmailBody(body: string) {
  if (!/[<&][a-zA-Z#/!]/.test(body)) {
    return body;
  }

  const doc = new DOMParser().parseFromString(body, "text/html");

  doc
    .querySelectorAll("script, style, noscript, svg")
    .forEach((node) => node.remove());

  doc
    .querySelectorAll("br")
    .forEach((node) => node.replaceWith(doc.createTextNode("\n")));

  doc
    .querySelectorAll("p, div, section, article, header, footer, tr, table")
    .forEach((node) => node.append(doc.createTextNode("\n")));

  doc
    .querySelectorAll("li")
    .forEach((node) => node.prepend(doc.createTextNode("\n- ")));

  const text = doc.body.textContent || body;

  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Two envelope shapes share the `WAYVE_SECURE_V1` prefix:
//   * `wayve_encrypted`        — single-recipient. Phase 1 (inbound
//     encrypt-on-arrival from external Gmail/Outlook senders) emits
//     this; `key` is one RSA-OAEP-wrapped AES key for the inbox owner.
//   * `wayve_encrypted_multi`  — multi-recipient. Phase 2 (Wayve-to-
//     Wayve native channel) emits this; `keys` is a map keyed by
//     recipient user_id so the same envelope row decrypts cleanly for
//     every recipient including the sender's Sent copy.
//
// The normaliser returns a discriminated union so the decryptor can
// pick the right wrapped key without re-parsing the JSON.
type ParsedWayveEnvelope =
  | { kind: "single"; data: number[]; key: number[]; iv: number[] }
  | { kind: "multi"; data: number[]; iv: number[]; keys: Record<string, number[]> };

function parseWayveEncryptedBody(body: string): ParsedWayveEnvelope | null {
  const trimmed = normalizeEmailBody(body).trim();

  if (!trimmed.startsWith(WAYVE_SECURE_PREFIX)) {
    return null;
  }

  const jsonStart = trimmed.indexOf("{");
  if (jsonStart === -1) {
    throw new Error("Encrypted Wayve email is missing its payload");
  }

  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonEnd < jsonStart) {
    throw new Error("Encrypted Wayve email payload is incomplete");
  }

  const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));

  if (
    parsed?.type === "wayve_encrypted" &&
    Array.isArray(parsed.data) &&
    Array.isArray(parsed.key) &&
    Array.isArray(parsed.iv)
  ) {
    return {
      kind: "single",
      data: parsed.data,
      key: parsed.key,
      iv: parsed.iv,
    };
  }

  if (
    parsed?.type === "wayve_encrypted_multi" &&
    Array.isArray(parsed.data) &&
    Array.isArray(parsed.iv) &&
    parsed.keys && typeof parsed.keys === "object"
  ) {
    return {
      kind: "multi",
      data: parsed.data,
      iv: parsed.iv,
      keys: parsed.keys as Record<string, number[]>,
    };
  }

  throw new Error("Encrypted Wayve email payload is invalid");
}

export function emailBodyErrorMessage(err: unknown) {
  const message = err instanceof Error ? err.message : "";

  if (
    message.includes("private key") ||
    message.includes("decrypt") ||
    message.includes("operation failed")
  ) {
    return "Unable to decrypt this fully encrypted email on this device. Sign out and back in to refresh your Wayve encryption key, then ask the sender to resend it.";
  }

  if (message) {
    return message;
  }

  return "Failed to load email body. Try again.";
}

export async function decryptWayveBodyIfNeeded(
  body: string,
  userId?: number | null
): Promise<string> {
  const encrypted = parseWayveEncryptedBody(body);

  if (!encrypted) {
    return normalizeEmailBody(body);
  }

  const privateKeys: CryptoKey[] = [];
  const scopedPrivateKey = await loadPrivateKey(userId);

  if (scopedPrivateKey) {
    privateKeys.push(scopedPrivateKey);
  }

  if (userId) {
    const legacyPrivateKey = await loadPrivateKey();
    if (legacyPrivateKey && legacyPrivateKey !== scopedPrivateKey) {
      privateKeys.push(legacyPrivateKey);
    }
  }

  if (privateKeys.length === 0) {
    throw new Error("This device does not have your Wayve private key");
  }

  // Pick the correct wrapped key per envelope shape:
  //   * single-recipient envelopes carry one `key` field for the inbox
  //     owner — used by Phase 1's inbound encrypt-on-arrival path.
  //   * multi-recipient envelopes carry a `keys` map indexed by
  //     recipient user_id — used by Phase 2's Wayve-to-Wayve channel.
  //     We MUST have a userId here to know which slot is ours; without
  //     it (legacy callers pre-Phase-2) we surface a clear error.
  let wrappedKeyBytes: number[];
  if (encrypted.kind === "single") {
    wrappedKeyBytes = encrypted.key;
  } else {
    if (!userId) {
      throw new Error(
        "Multi-recipient Wayve email decryption requires a userId — no slot to read from `keys`."
      );
    }
    const slot = encrypted.keys[String(userId)];
    if (!slot) {
      throw new Error(
        "No wrapped key for this user in the email envelope — the sender did not include you."
      );
    }
    wrappedKeyBytes = slot;
  }

  let lastError: unknown = null;

  for (const privateKey of privateKeys) {
    try {
      return await decryptMessage(
        new Uint8Array(encrypted.data),
        new Uint8Array(wrappedKeyBytes),
        new Uint8Array(encrypted.iv),
        privateKey
      ).then(normalizeEmailBody);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Unable to decrypt Wayve email");
}
