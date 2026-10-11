import { downloadEmailAttachment, type EmailAttachment } from "../api/email";
import { formatFileSize } from "./renderUtils";

// A message's attachments as download buttons. Shared by the reading pane and
// the earlier messages of a conversation, so both download (and decrypt) the
// same way. Renders nothing when there are none.
export function EmailAttachments({
  attachments,
  userId,
}: {
  attachments?: EmailAttachment[] | null;
  userId: number | null;
}) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="email-attachments">
      <div className="email-attachments-title">Attachments</div>
      {attachments.map((attachment) => (
        <button
          key={attachment.id}
          className="email-attachment"
          onClick={() => downloadEmailAttachment(attachment, userId)}
        >
          <span className="email-attachment-icon">📎</span>
          <span className="email-attachment-name">{attachment.filename}</span>
          <span className="email-attachment-size">
            {formatFileSize(attachment.size)}
          </span>
        </button>
      ))}
    </div>
  );
}
