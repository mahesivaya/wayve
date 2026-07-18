import React, { useState } from "react";
import { EmailAccount, EmailFolder } from "./types";
import { PullRequestIcon } from "../icons";

interface EmailSidebarProps {
  accounts: EmailAccount[];
  activeAccount: number | null;
  setActiveAccount: (id: number | null) => void;
  activeFolder: EmailFolder;
  setActiveFolder: (folder: EmailFolder) => void;
  viewMode: "email" | "files";
  onOpenFiles: () => void;
  // The picker is owned by the parent, so the same modal is shared with the
  // email-list empty-state CTA.
  onRequestAddAccount: () => void;
  onCompose: () => void;
  composeDisabled: boolean;
  width: number;
  onRenameAccount: (id: number, displayName: string | null) => Promise<void>;
  // The account filter list. Shown for any scope with at least one account, so
  // org and platform users get the unified view but can still drill into a
  // single shared inbox.
  showAccountFilter?: boolean;
  // Account management affordances. Personal-only: org and platform mailboxes
  // are managed in /settings/inboxes.
  showAccountManagement?: boolean;
  // Org and platform pages move Compose into the page toolbar, so the sidebar
  // copy is hidden to avoid showing two.
  showComposeButton?: boolean;
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
          data-tooltip={composeDisabled ? "No inbox available" : "Compose"}
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
            data-tooltip="Add account"
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
              // Summed client-side from the counts /api/accounts already
              // returns, so this needs no extra round-trip and stays in
              // lock-step with each row's own pill below.
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
            // A shared inbox prefers `shared_label`, since `display_name` is a
            // nickname the owner gave it that doesn't carry over to members.
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
                      data-tooltip="Save name"
                      aria-label="Save name"
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      className="account-icon-btn"
                      onClick={() => setEditingAccountId(null)}
                      data-tooltip="Cancel"
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
                      data-tooltip={
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
                        data-tooltip="Edit account name"
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
          {/* Virtual folder cutting across every account, matched by sender on
            the backend rather than by label. */}
          <button
            className={`filter-btn ${activeFolder === "github" && viewMode === "email" ? "active" : ""}`}
            onClick={() => setActiveFolder("github")}
          >
            <span className="email-chip-label">
              <PullRequestIcon size={14} /> Reviews
            </span>
          </button>
          {/* Category folders, all filtered on `emails.labels`. */}
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
