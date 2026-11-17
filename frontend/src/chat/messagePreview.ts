import {
  decryptChatContent,
  E2E_BEFORE_SETUP_TEXT,
  E2E_UNAVAILABLE_TEXT,
  isEncryptedChatContent,
  parseChatAttachments,
} from "./e2ee";

const PREVIEW_CHARS = 140;

// A one-line preview of a chat message, decrypted on this device, for the
// app-wide new-message popups. Null when it can't be read here, so the card
// says "New message" rather than showing an error.
export async function messagePreview(
  content: string,
  myId: number
): Promise<string | null> {
  const files = parseChatAttachments(content).length;
  let text = content;
  if (isEncryptedChatContent(content)) {
    text = await decryptChatContent(content, myId);
    if (text === E2E_UNAVAILABLE_TEXT || text === E2E_BEFORE_SETUP_TEXT) {
      return null;
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text) {
    return files > 0 ? `📎 ${files} attachment${files === 1 ? "" : "s"}` : null;
  }
  return text.length > PREVIEW_CHARS
    ? `${text.slice(0, PREVIEW_CHARS - 1)}…`
    : text;
}
