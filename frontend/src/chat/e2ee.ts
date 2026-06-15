import { decryptMessage } from "../crypto/crypto";
import { loadPrivateKey } from "../crypto/keyStore";
import type { ChatMessage } from "../api/chat";

const CHAT_E2E_PREFIX = "WAYVE_CHAT_E2E_V1\n";

// Attachment descriptor carried INSIDE the E2E envelope (so filename/size stay
// private even in server-encrypted mode). `iv` present ⇒ the file body is
// end-to-end encrypted with this message's AES key (decrypt client-side);
// absent ⇒ the body is server-encrypted (download returns plaintext).
export type ChatAttachmentDescriptor = {
  id: number;
  name: string;
  mime: string | null;
  size: number;
  iv?: number[];
};

type ChatEnvelope = {
  type: "wayve_chat_e2e";
  data: number[];
  iv: number[];
  keys: Record<string, number[]>;
  attachments?: ChatAttachmentDescriptor[];
};

const toArrayBuffer = (input: ArrayBuffer | Uint8Array) =>
  input instanceof Uint8Array ? input.slice().buffer : input;

const importPublicKey = (bytes: number[] | ArrayBuffer | Uint8Array) =>
  crypto.subtle.importKey(
    "spki",
    toArrayBuffer(bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)),
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    true,
    ["encrypt"]
  );

const parseEnvelope = (content: string): ChatEnvelope | null => {
  if (!content.startsWith(CHAT_E2E_PREFIX)) return null;

  try {
    const parsed = JSON.parse(
      content.slice(CHAT_E2E_PREFIX.length)
    ) as Partial<ChatEnvelope>;
    if (
      parsed.type !== "wayve_chat_e2e" ||
      !Array.isArray(parsed.data) ||
      !Array.isArray(parsed.iv) ||
      !parsed.keys
    ) {
      return null;
    }

    return parsed as ChatEnvelope;
  } catch {
    return null;
  }
};

export const isEncryptedChatContent = (content: string) =>
  Boolean(parseEnvelope(content));

// Fresh per-message AES-256-GCM key. Used for the text AND any e2e attachments
// in the same message, so the recipient unwraps one key to read everything.
export const generateChatKey = () =>
  crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);

// Encrypt one file body with the message AES key (e2e mode). Returns the
// ciphertext to upload and the iv to record in the attachment descriptor.
export async function encryptChatFile(
  aesKey: CryptoKey,
  file: Blob
): Promise<{ ciphertext: ArrayBuffer; iv: number[] }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    await file.arrayBuffer()
  );
  return { ciphertext, iv: Array.from(iv) };
}

// Build the full E2E envelope: encrypt the text with `aesKey`, RSA-wrap that key
// for each recipient, and carry the attachment descriptors.
export async function buildChatEnvelope(
  plaintext: string,
  aesKey: CryptoKey,
  recipientPublicKeys: Map<number, number[] | ArrayBuffer | Uint8Array>,
  attachments?: ChatAttachmentDescriptor[]
): Promise<string> {
  if (recipientPublicKeys.size === 0) {
    throw new Error("No recipient encryption keys available");
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedMessage = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(plaintext)
  );
  const rawKey = await crypto.subtle.exportKey("raw", aesKey);
  const keys: Record<string, number[]> = {};

  for (const [userId, publicKeyBytes] of recipientPublicKeys) {
    const publicKey = await importPublicKey(publicKeyBytes);
    const encryptedKey = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      publicKey,
      rawKey
    );
    keys[String(userId)] = Array.from(new Uint8Array(encryptedKey));
  }

  const envelope: ChatEnvelope = {
    type: "wayve_chat_e2e",
    data: Array.from(new Uint8Array(encryptedMessage)),
    iv: Array.from(iv),
    keys,
  };
  if (attachments && attachments.length > 0) {
    envelope.attachments = attachments;
  }
  return `${CHAT_E2E_PREFIX}${JSON.stringify(envelope)}`;
}

// Text-only convenience (unchanged behavior): generate a key + build envelope.
export async function encryptChatContent(
  plaintext: string,
  recipientPublicKeys: Map<number, number[] | ArrayBuffer | Uint8Array>
) {
  const aesKey = await generateChatKey();
  return buildChatEnvelope(plaintext, aesKey, recipientPublicKeys);
}

// Parsed attachment descriptors from an (undecrypted) envelope, for rendering.
export const parseChatAttachments = (
  content: string
): ChatAttachmentDescriptor[] => parseEnvelope(content)?.attachments ?? [];

// Recover the message AES key for this user (to decrypt e2e attachments on
// demand). Returns null if the envelope/key/private key is unavailable.
export async function unwrapChatKey(
  content: string,
  currentUserId: number
): Promise<CryptoKey | null> {
  const envelope = parseEnvelope(content);
  if (!envelope) return null;
  const privateKey = await loadPrivateKey(currentUserId);
  const encryptedKey = envelope.keys[String(currentUserId)];
  if (!privateKey || !encryptedKey) return null;
  try {
    const rawKey = await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      privateKey,
      new Uint8Array(encryptedKey)
    );
    return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, [
      "decrypt",
    ]);
  } catch {
    return null;
  }
}

// Decrypt one e2e attachment body with the message AES key + its iv.
export const decryptChatFile = (
  aesKey: CryptoKey,
  ciphertext: ArrayBuffer,
  iv: number[]
): Promise<ArrayBuffer> =>
  crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    aesKey,
    ciphertext
  );

export async function decryptChatContent(
  content: string,
  currentUserId: number
) {
  const envelope = parseEnvelope(content);
  if (!envelope) return content;

  const privateKey = await loadPrivateKey(currentUserId);
  const encryptedKey = envelope.keys[String(currentUserId)];

  if (!privateKey || !encryptedKey) {
    return "[encrypted message unavailable on this device]";
  }

  try {
    return await decryptMessage(
      new Uint8Array(envelope.data),
      new Uint8Array(encryptedKey),
      new Uint8Array(envelope.iv),
      privateKey
    );
  } catch {
    return "[encrypted message unavailable on this device]";
  }
}

// Decrypt one message: replace `content` with plaintext and, when the envelope
// carries attachments, surface their descriptors + keep the raw envelope so the
// bubble can lazily unwrap the AES key for e2e attachment downloads.
export async function decryptChatMessage<T extends ChatMessage>(
  message: T,
  currentUserId: number
): Promise<T> {
  const attachments = parseChatAttachments(message.content);
  const content = await decryptChatContent(message.content, currentUserId);
  if (attachments.length === 0) {
    return { ...message, content };
  }
  return { ...message, content, attachments, _envelope: message.content };
}

export async function decryptChatMessages(
  messages: ChatMessage[],
  currentUserId: number
) {
  return Promise.all(
    messages.map((message) => decryptChatMessage(message, currentUserId))
  );
}
