import type { ReactNode } from "react";
import { EmailFolder } from "./types";
import { PullRequestIcon } from "../icons";

// The Inbox / Sent / GitHub PRs folder chips, shared by the list header, the
// attachments view, and (in a split pane) the emails page toolbar — one
// definition so the menu reads the same everywhere it appears.
export function FolderChips({
  activeFolder,
  onSelectFolder,
  onShowAttachments,
  filesActive,
}: {
  // null/undefined = no folder highlighted (e.g. while the files view is open).
  activeFolder?: EmailFolder | null;
  onSelectFolder: (folder: EmailFolder) => void;
  // The attachments view. Not a folder — it swaps the whole pane — so it rides
  // beside the folder chips rather than going through `onSelectFolder`. Omit to
  // leave the chip out.
  onShowAttachments?: () => void;
  filesActive?: boolean;
}) {
  const chip = (folder: EmailFolder, label: ReactNode, title: string) => (
    <button
      type="button"
      className={`email-bulk-action${activeFolder === folder ? " is-active" : ""}`}
      onClick={() => onSelectFolder(folder)}
      aria-pressed={activeFolder === folder}
      data-tooltip={title}
    >
      {label}
    </button>
  );

  return (
    <div className="email-folder-tabs" role="group" aria-label="Mail folder">
      {/* "All" is the inbox; Signal/Noise are inbox sub-views (empty for now). */}
      {chip("inbox", "All", "All inbox mail")}
      {chip("signal", "Signal", "Signal")}
      {chip("noise", "Noise", "Noise")}
      {chip("sent", "Sent", "Sent")}
      {/* Sits next to Sent, where it's read as another place mail lives, rather
        than as a paperclip lost among the bulk-action icons at the far end. */}
      {onShowAttachments && (
        <button
          type="button"
          className={`email-bulk-action${filesActive ? " is-active" : ""}`}
          onClick={onShowAttachments}
          aria-pressed={filesActive ?? false}
          data-tooltip="All attachments across your emails"
        >
          Docs
        </button>
      )}
      {chip(
        "github",
        <span className="email-chip-label">
          <PullRequestIcon size={14} /> Reviews
        </span>,
        "GitHub pull request review emails"
      )}
    </div>
  );
}
