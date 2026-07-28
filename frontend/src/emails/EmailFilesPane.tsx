import type { ReactNode } from "react";

import type { EmailAttachment } from "../api/email";
import { downloadEmailAttachment } from "../api/email";
import type { EmailFolder } from "./types";
import { FolderChips } from "./FolderChips";
import { useAuth } from "../auth/useAuth";
import { formatFileSize } from "./renderUtils";
import { fmtListTimestamp } from "../utils/datetime";

// The attachments view, split the way the mail itself is: the list of files on
// the left where the email list sits, the selected file's details on the right
// where the message would be. Clicking a row used to fire a download straight
// off the list, which gave no way to look at a file before committing to it —
// selection now opens the details, and downloading is a button there.

export function EmailFilesList({
  files,
  filesLoading,
  filesError,
  emptyMessage,
  progressNote,
  selectedFileId,
  onSelectFile,
  onSelectFolder,
  onShowAttachments,
  width,
}: {
  files: EmailAttachment[];
  filesLoading: boolean;
  filesError: string | null;
  emptyMessage: ReactNode;
  // Shown above the list while the inbox is still being scanned for
  // attachments, so a short list doesn't read as the final answer.
  progressNote?: ReactNode;
  selectedFileId: number | null;
  onSelectFile: (file: EmailAttachment) => void;
  // Same folder chips as the email list header, so the menu doesn't vanish
  // while browsing attachments. Omitted where the sidebar already navigates.
  onSelectFolder?: (folder: EmailFolder) => void;
  onShowAttachments?: () => void;
  width?: number;
}) {
  return (
    <div
      className="email-list email-files-list-pane"
      style={width ? { width, flex: "0 0 auto" } : undefined}
    >
      {onSelectFolder && (
        <div
          className="email-bulk-bar"
          role="toolbar"
          aria-label="Mail folders"
        >
          <FolderChips
            activeFolder={null}
            onSelectFolder={onSelectFolder}
            onShowAttachments={onShowAttachments}
            filesActive
          />
        </div>
      )}
      <div className="email-files-header">
        <h2>Files</h2>
      </div>
      {filesLoading ? (
        <div className="email-files-empty">Loading files…</div>
      ) : filesError ? (
        <div className="email-files-error">{filesError}</div>
      ) : files.length === 0 ? (
        <div className="email-files-empty">{emptyMessage}</div>
      ) : (
        <>
          {progressNote}
          <div className="email-files-list">
            {files.map((file) => (
              <button
                key={file.id}
                type="button"
                className={`email-files-row${
                  file.id === selectedFileId ? " is-selected" : ""
                }`}
                aria-current={file.id === selectedFileId}
                onClick={() => onSelectFile(file)}
              >
                <span className="email-files-icon">📎</span>
                <span className="email-files-main">
                  <span className="email-files-name">{file.filename}</span>
                  <span className="email-files-meta">
                    {file.subject || "No subject"} ·{" "}
                    {file.sender || "Unknown sender"}
                  </span>
                </span>
                <span className="email-files-size">
                  {formatFileSize(file.size)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function EmailFileDetail({
  file,
  onBack,
}: {
  file: EmailAttachment | null;
  // In list view the details replace the list rather than sitting beside it, so
  // the pane carries the only way back — same Back button the email detail has.
  onBack?: () => void;
}) {
  const { user } = useAuth();

  if (!file) {
    return (
      <div className="email-detail email-detail--files">
        <p className="email-files-empty">Select a file</p>
      </div>
    );
  }

  // Only the fields the attachment row actually carries; a missing one drops
  // out rather than rendering an empty label.
  const rows: [string, string | null | undefined][] = [
    ["From", file.sender],
    ["To", file.receiver],
    ["Subject", file.subject],
    ["Date", file.created_at ? fmtListTimestamp(file.created_at) : null],
    ["Type", file.mime_type],
    ["Size", formatFileSize(file.size) || null],
  ];

  return (
    <div className="email-detail email-detail--files">
      <div className="email-file-detail">
        {onBack && (
          <button
            type="button"
            className="email-detail-back-top"
            onClick={onBack}
            data-tooltip="Back to files"
            aria-label="Back to files"
          >
            <svg
              className="email-detail-back-top-icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M15 6l-6 6 6 6" />
            </svg>
            <span>Back</span>
          </button>
        )}
        <div className="email-file-detail-head">
          <span className="email-files-icon" aria-hidden="true">
            📎
          </span>
          <h2 className="email-file-detail-name">{file.filename}</h2>
        </div>
        <dl className="email-file-detail-meta">
          {rows
            .filter(([, value]) => Boolean(value))
            .map(([label, value]) => (
              <div className="email-file-detail-row" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
        <button
          type="button"
          className="email-file-detail-download"
          onClick={() => downloadEmailAttachment(file, user?.id ?? null)}
        >
          Download
        </button>
      </div>
    </div>
  );
}
