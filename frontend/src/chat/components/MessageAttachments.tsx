import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatAttachmentMeta } from "../../api/chat";
import { downloadChatAttachment } from "../../api/chat";
import { unwrapChatKey, decryptChatFile } from "../e2ee";
import { logger } from "../../utils/logger";

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const isImage = (mime: string | null) =>
  !!mime && mime.startsWith("image/");

// Resolve an attachment to a Blob with its real mime: use the local file on the
// sender's own optimistic bubble, else download (and decrypt when e2e).
async function resolveBlob(
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

function AttachmentItem({
  att,
  message,
  localFile,
  currentUserId,
}: {
  att: ChatAttachmentMeta;
  message: ChatMessage;
  localFile: File | undefined;
  currentUserId?: number;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const urlRef = useRef<string | null>(null);

  const image = isImage(att.mime);

  // Auto-load image previews; revoke the object URL on unmount.
  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    setBusy(true);
    resolveBlob(att, message, localFile, currentUserId)
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setImageUrl(url);
      })
      .catch((e) => {
        if (!cancelled) setError("Couldn't load image");
        logger.warn("attachment image load failed", e);
      })
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.id]);

  const downloadFile = async () => {
    setError("");
    setBusy(true);
    try {
      const blob = await resolveBlob(att, message, localFile, currentUserId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = att.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError("Download failed");
      logger.warn("attachment download failed", e);
    } finally {
      setBusy(false);
    }
  };

  if (image) {
    return (
      <div className="message-attachment-image">
        {imageUrl ? (
          <img src={imageUrl} alt={att.name} />
        ) : (
          <div className="message-attachment-image-placeholder">
            {error || (busy ? "Loading…" : att.name)}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="message-attachment-file"
      onClick={() => void downloadFile()}
      disabled={busy}
      title={`Download ${att.name}`}
    >
      <span className="message-attachment-file-icon" aria-hidden="true">
        📄
      </span>
      <span className="message-attachment-file-meta">
        <span className="message-attachment-file-name">{att.name}</span>
        <span className="message-attachment-file-size">
          {error || (busy ? "Downloading…" : fmtSize(att.size))}
        </span>
      </span>
    </button>
  );
}

export default function MessageAttachments({
  message,
  currentUserId,
}: {
  message: ChatMessage;
  currentUserId?: number;
}) {
  const atts = message.attachments ?? [];
  if (atts.length === 0) return null;
  return (
    <div className="message-attachments">
      {atts.map((att, i) => (
        <AttachmentItem
          key={att.id}
          att={att}
          message={message}
          localFile={message._localFiles?.[i]}
          currentUserId={currentUserId}
        />
      ))}
    </div>
  );
}
