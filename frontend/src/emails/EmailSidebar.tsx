import React, { useState } from "react";
import { EmailAccount, EmailFolder } from "./types";

interface EmailSidebarProps {
  accounts: EmailAccount[];
  activeAccount: number | null;
  setActiveAccount: (id: number | null) => void;
  activeFolder: EmailFolder;
  setActiveFolder: (folder: EmailFolder) => void;
  viewMode: "email" | "files";
  onOpenFiles: () => void;
  // Opens the "add a mailbox" picker, which the parent owns (so the same
  // modal is shared with the email-list empty-state CTA).
  onRequestAddAccount: () => void;
  onCompose: () => void;
  composeDisabled: boolean;
  width: number;
  onRenameAccount: (id: number, displayName: string | null) => Promise<void>;
  // Whether to show the account *filter* list (the "🌐 All Accounts" pill + the
  // per-account rows). Shown for any scope that has ≥1 account, so organization /
  // platform users get the unified "all emails" view by default and can still drill
  // into a single shared inbox.
  showAccountFilter?: boolean;
  // Whether to show account *management* affordances (the "Accounts" header + the
  // "+ add mailbox" button). Personal-only — org/platform mailboxes are managed in
  // /settings/inboxes, not from the inbox sidebar.
  showAccountManagement?: boolean;
  // Personal accounts keep the Compose button at the top of the sidebar.
  // Organization / platform pages move it into the page toolbar instead, so
  // they hide the sidebar copy to avoid showing two.
  showComposeButton?: boolean;
  // The Gmail-style folder nav (Inbox/Sent/Important/…/Attachments). Personal
  // accounts show it; organization / platform pages hide the whole block.
  showFolderNav?: boolean;
}

export const EmailSidebar: React.FC<EmailSidebarProps> = ({
  accounts,
  activeAccount,
  setActiveAccount,
  activeFolder,
  setActiveFolder,
  viewMode,
  onOpenFiles,
  onRequestAddAccount,
  onCompose,
  composeDisabled,
  width,
  onRenameAccount,
  showAccountFilter = true,
  showAccountManagement = true,
  showComposeButton = true,
  showFolderNav = true,
}) => {
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [savingAccountId, setSavingAccountId] = useState<number | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  const startEditing = (account: EmailAccount) => {
    setEditingAccountId(account.id);
    setDraftName(account.display_name || account.email);
    setRenameError(null);
  };

  const saveName = async (account: EmailAccount) => {
    const trimmed = draftName.trim();
    const displayName = trimmed && trimmed !== account.email ? trimmed : null;
    setSavingAccountId(account.id);
    setRenameError(null);
    try {
      await onRenameAccount(account.id, displayName);
      setEditingAccountId(null);
    } catch (err) {
      setRenameError(
        err instanceof Error ? err.message : "Could not save account name"
      );
    } finally {
      setSavingAccountId(null);
    }
  };

  return (
    <div className="email-sidebar" style={{ width }}>
      {showComposeButton && (
        <button
          className="compose-btn"
          onClick={onCompose}
          disabled={composeDisabled}
          title={composeDisabled ? "No inbox available" : "Compose"}
        >
          Compose
        </button>
      )}

      {showAccountManagement && (
        <div className="mail-section-header">
          <span className="mail-section-title">Accounts</span>
          <button
            type="button"
            className="mail-section-action"
            onClick={onRequestAddAccount}
            aria-haspopup="dialog"
            aria-label="Add account"
            title="Add account"
          >
            +
          </button>
        </div>
      )}

      {showAccountFilter && (
        <nav className="mail-filters" aria-label="Mail accounts">
          <button
            className={`filter-btn ${activeAccount === null ? "active" : ""}`}
            onClick={() => setActiveAccount(null)}
          >
            <span className="filter-btn-label">🌐 All Accounts</span>
            {(() => {
              // Sum of per-account `unread_count`s. The backend already
              // returns these in /api/accounts (see email::account), so we
              // skip an extra round-trip and the badge stays in lock-step
              // with each row's own pill below.
              const total = accounts.reduce(
                (sum, acc) => sum + (acc.unread_count ?? 0),
                0
              );
              return total > 0 ? (
                <span
                  className="account-unread-count"
                  aria-label={`${total} unread emails across all accounts`}
                >
                  {total}
                </span>
              ) : null;
            })()}
          </button>

          {accounts.map((acc) => {
            const isEditing = editingAccountId === acc.id;
            // For shared inboxes the human-friendly `shared_label` ("Support")
            // is the most useful name; `display_name` is the personal nickname
            // the owner-user gave it, which doesn't carry over for members.
            const displayName =
              (acc.is_shared && acc.shared_label?.trim()) ||
              acc.display_name?.trim() ||
              acc.email;

            return (
              <div
                key={acc.id}
                className={`account-filter ${activeAccount === acc.id ? "active" : ""} ${acc.is_shared ? "shared" : ""}`}
              >
                {isEditing ? (
                  <div className="account-edit-row">
                    <input
                      className="account-name-input"
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          void saveName(acc);
                        }
                        if (e.key === "Escape") {
                          setEditingAccountId(null);
                        }
                      }}
                      aria-label={`Edit name for ${acc.email}`}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="account-icon-btn"
                      onClick={() => void saveName(acc)}
                      disabled={savingAccountId === acc.id}
                      title="Save name"
                      aria-label="Save name"
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      className="account-icon-btn"
                      onClick={() => setEditingAccountId(null)}
                      title="Cancel"
                      aria-label="Cancel"
                    >
                      ×
                    </button>
                    {renameError && (
                      <span className="account-rename-error">
                        {renameError}
                      </span>
                    )}
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="account-filter-main"
                      onClick={() => setActiveAccount(acc.id)}
                      title={
                        acc.is_shared
                          ? `Shared inbox · ${acc.email}`
                          : acc.email
                      }
                    >
                      <span className="account-filter-label">
                        {displayName}
                        {acc.is_shared && (
                          <span
                            className="account-shared-chip"
                            aria-label="Shared inbox"
                          >
                            Shared
                          </span>
                        )}
                      </span>
                      <span
                        className="account-unread-count"
                        aria-label={`${acc.unread_count ?? 0} unread emails`}
                      >
                        {acc.unread_count ?? 0}
                      </span>
                    </button>
                    {/* Only the owner-user may rename. Members see no pencil. */}
                    {acc.is_owner !== false && (
                      <button
                        type="button"
                        className="account-icon-btn"
                        onClick={() => startEditing(acc)}
                        title="Edit account name"
                        aria-label={`Edit name for ${acc.email}`}
                      >
                        ✎
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </nav>
      )}

      {showFolderNav && (
        <nav className="mail-filters" aria-label="Mail folders">
          <button
            className={`filter-btn ${activeFolder === "inbox" && viewMode === "email" ? "active" : ""}`}
            onClick={() => setActiveFolder("inbox")}
          >
            📥 Inbox
          </button>
          <button
            className={`filter-btn ${activeFolder === "sent" && viewMode === "email" ? "active" : ""}`}
            onClick={() => setActiveFolder("sent")}
          >
            📤 Sent
          </button>
          {/* Gmail-style category folders. All wired to `emails.labels`
            (Gmail labelIds + Outlook categories + synthetic SPAM/DRAFT
            from the side-pull sync paths). */}
          <button
            className={`filter-btn ${activeFolder === "important" && viewMode === "email" ? "active" : ""}`}
            onClick={() => setActiveFolder("important")}
          >
            ⭐ Important
          </button>
          <button
            className={`filter-btn ${activeFolder === "updates" && viewMode === "email" ? "active" : ""}`}
            onClick={() => setActiveFolder("updates")}
          >
            🔔 Updates
          </button>
          <button
            className={`filter-btn ${activeFolder === "social" && viewMode === "email" ? "active" : ""}`}
            onClick={() => setActiveFolder("social")}
          >
            👥 Social
          </button>
          <button
            className={`filter-btn ${activeFolder === "drafts" && viewMode === "email" ? "active" : ""}`}
            onClick={() => setActiveFolder("drafts")}
          >
            📝 Drafts
          </button>
          <button
            className={`filter-btn ${activeFolder === "spam" && viewMode === "email" ? "active" : ""}`}
            onClick={() => setActiveFolder("spam")}
          >
            🚫 Spam
          </button>
          <button
            className={`filter-btn ${activeFolder === "trash" && viewMode === "email" ? "active" : ""}`}
            onClick={() => setActiveFolder("trash")}
          >
            <svg
              viewBox="0 0 24 24"
              width="1em"
              height="1em"
              fill="none"
              stroke="#dc2626"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ verticalAlign: "-0.15em", marginRight: "0.45em" }}
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
            Trash
          </button>
          <button
            className={`filter-btn ${viewMode === "files" ? "active" : ""}`}
            onClick={onOpenFiles}
          >
            📎 Attachments
          </button>
        </nav>
      )}
    </div>
  );
};
