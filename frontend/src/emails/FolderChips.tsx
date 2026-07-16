import { EmailFolder } from "./types";

// The Inbox / Sent / GitHub PRs folder chips, shared by the list header, the
// attachments view, and (in a split pane) the emails page toolbar — one
// definition so the menu reads the same everywhere it appears.
export function FolderChips({
  activeFolder,
  onSelectFolder,
}: {
  // null/undefined = no folder highlighted (e.g. while the files view is open).
  activeFolder?: EmailFolder | null;
  onSelectFolder: (folder: EmailFolder) => void;
}) {
  const chip = (folder: EmailFolder, label: string, title: string) => (
    <button
      type="button"
      className={`email-bulk-action${activeFolder === folder ? " is-active" : ""}`}
      onClick={() => onSelectFolder(folder)}
      aria-pressed={activeFolder === folder}
      title={title}
    >
      {label}
    </button>
  );

  return (
    <div className="email-folder-tabs" role="group" aria-label="Mail folder">
      {chip("inbox", "Inbox", "Inbox")}
      {chip("sent", "Sent", "Sent")}
      {chip("github", "🐙 GitHub PRs", "GitHub pull request emails")}
    </div>
  );
}
