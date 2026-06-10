import { decryptMessage } from "../crypto/crypto";
import { loadPrivateKey } from "../crypto/keyStore";
import type { ChatMessage } from "../api/chat";

const CHAT_E2E_PREFIX = "WAYVE_CHAT_E2E_V1\n";

type ChatEnvelope = {
  type: "wayve_chat_e2e";
  data: number[];
  iv: number[];
  keys: Record<string, number[]>;
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

export async function encryptChatContent(
  plaintext: string,
  recipientPublicKeys: Map<number, number[] | ArrayBuffer | Uint8Array>
) {
  if (recipientPublicKeys.size === 0) {
    throw new Error("No recipient encryption keys available");
  }

  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
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

  return `${CHAT_E2E_PREFIX}${JSON.stringify({
    type: "wayve_chat_e2e",
    data: Array.from(new Uint8Array(encryptedMessage)),
    iv: Array.from(iv),
    keys,
  } satisfies ChatEnvelope)}`;
}

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

export async function decryptChatMessages(
  messages: ChatMessage[],
  currentUserId: number
) {
  return Promise.all(
    messages.map(async (message) => ({
      ...message,
      content: await decryptChatContent(message.content, currentUserId),
    }))
  );
}
