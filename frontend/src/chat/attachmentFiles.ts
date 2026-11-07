// Chat attachment helpers shared by message bubbles and the DM profile panel's
// file list: size formatting, and fetching (plus E2E-decrypting) a file.
import type { ChatMessage, ChatAttachmentMeta } from "../api/chat";
import { downloadChatAttachment } from "../api/chat";
import { unwrapChatKey, decryptChatFile } from "./e2ee";

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const isImage = (mime: string | null) =>
  !!mime && mime.startsWith("image/");

// Resolve an attachment to a Blob with its real mime: use the local file on the
// sender's own optimistic bubble, else download (and decrypt when e2e).
export async function resolveBlob(
  att: ChatAttachmentMeta,
  message: ChatMessage,
  localFile: File | undefined,
  currentUserId?: number
): Promise<Blob> {
  if (localFile) return localFile;

  const bytes = await downloadChatAttachment(att.id);
  if (att.iv && message._envelope && currentUserId != null) {
    const key = await unwrapChatKey(message._envelope, currentUserId);
    if (!key) throw new Error("Cannot decrypt this attachment on this device");
    const plain = await decryptChatFile(key, bytes, att.iv);
    return new Blob([plain], att.mime ? { type: att.mime } : undefined);
  }
  return new Blob([bytes], att.mime ? { type: att.mime } : undefined);
}

// Fetch (and decrypt) an attachment and hand it to the browser as a download.
// Shared by message bubbles and the DM details panel's file list.
export async function downloadAttachment(
  att: ChatAttachmentMeta,
  message: ChatMessage,
  currentUserId?: number,
  localFile?: File
): Promise<void> {
  const blob = await resolveBlob(att, message, localFile, currentUserId);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = att.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
