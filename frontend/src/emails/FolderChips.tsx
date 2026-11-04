import { useEffect, useRef, useState } from "react";
import { EmailFolder } from "./types";

type FolderChip = { folder: EmailFolder; label: string };

// The mail folder chips, shared by the list header, the attachments view, and
// (in a split pane) the emails page toolbar — one definition so the menu reads
// the same everywhere it appears.
const FOLDER_CHIPS: ReadonlyArray<FolderChip> = [
  { folder: "inbox", label: "Inbox" },
  { folder: "sent", label: "Sent" },
  { folder: "drafts", label: "Draft" },
  { folder: "scheduled", label: "Scheduled" },
  { folder: "starred", label: "Starred" },
  { folder: "trash", label: "Trash" },
];

const MORE_FOLDERS: ReadonlyArray<FolderChip> = [
  { folder: "spam", label: "Spam" },
  { folder: "promotions", label: "Promotions" },
  { folder: "archived", label: "Archived" },
  { folder: "github", label: "Reviews" },
];

export function FolderChips({
  activeFolder,
  onSelectFolder,
  onShowAttachments,
  filesActive,
}: {
  // null/undefined = no folder highlighted (e.g. while the files view is open).
  activeFolder?: EmailFolder | null;
  onSelectFolder: (folder: EmailFolder) => void;
  // The attachments view. Not a folder — it swaps the whole pane — so it doesn't
  // go through `onSelectFolder`. Omit to leave "Docs" out of the dropdown.
  onShowAttachments?: () => void;
  filesActive?: boolean;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  // The trigger names the folder you're in, so a tab always says where you are.
  const activeMore = filesActive
    ? "Docs"
    : MORE_FOLDERS.find((f) => f.folder === activeFolder)?.label;

  // Closes on Escape or a click outside the menu.
  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        moreRef.current &&
        event.target instanceof Node &&
        !moreRef.current.contains(event.target)
      ) {
        setMoreOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);

  return (
    <div className="email-folder-tabs" role="group" aria-label="Mail folder">
      {FOLDER_CHIPS.map(({ folder, label }) => (
        <button
          key={folder}
          type="button"
          className={`email-bulk-action${activeFolder === folder ? " is-active" : ""}`}
          onClick={() => onSelectFolder(folder)}
          aria-pressed={activeFolder === folder}
          data-tooltip={label}
        >
          {label}
        </button>
      ))}
      <div className="email-folder-more" ref={moreRef}>
        <button
          type="button"
          className={`email-bulk-action${activeMore ? " is-active" : ""}`}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          {activeMore ?? "More"} ▾
        </button>
        {moreOpen && (
          <div className="email-select-menu" role="menu">
            {MORE_FOLDERS.map(({ folder, label }) => (
              <button
                key={folder}
                type="button"
                role="menuitem"
                className="email-select-item"
                onClick={() => {
                  setMoreOpen(false);
                  onSelectFolder(folder);
                }}
              >
                {label}
              </button>
            ))}
            {onShowAttachments && (
              <button
                type="button"
                role="menuitem"
                className="email-select-item"
                onClick={() => {
                  setMoreOpen(false);
                  onShowAttachments();
                }}
              >
                Docs
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
