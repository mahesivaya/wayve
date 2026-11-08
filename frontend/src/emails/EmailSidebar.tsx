import React, { useState } from "react";
import { EmailAccount, EmailFolder } from "./types";
import MailFolderNav from "./MailFolderNav";
import { ComposeIcon, RenameIcon } from "../icons";

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
  // Gmail-style icon rail for the emails page inside a split pane: Compose as
  // an icon, then the folder and label icons. The accounts list is left out.
  rail?: boolean;
  // Split pane only: the ☰ button above Compose that switches between the
  // icon rail and the full menu with names.
  onToggleMenu?: () => void;
  // Phones: the full menu as a slide-in drawer over the page.
  drawer?: boolean;
}

// ☰ toggle between the icon rail and the full menu (split pane only).
// Width of the icon rail (.email-sidebar--rail in emails.css). The expanded
// menu in a pane keeps this footprint and draws the rest over the list.
const RAIL_WIDTH_PX = 70;

function MenuToggle({
  expanded,
  onClick,
}: {
  expanded: boolean;
  onClick: () => void;
}) {
  const label = expanded ? "Collapse menu" : "Expand menu";
  return (
    <button
      type="button"
      className="email-menu-toggle"
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      title={label}
    >
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M4 7h16 M4 12h16 M4 17h16" />
      </svg>
    </button>
  );
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
  rail = false,
  onToggleMenu,
  drawer = false,
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

  if (rail) {
    return (
      <div className="email-sidebar email-sidebar--rail">
        {onToggleMenu && <MenuToggle expanded={false} onClick={onToggleMenu} />}
        {showComposeButton && (
          <button
            type="button"
            className="compose-btn compose-btn--rail"
            onClick={onCompose}
            disabled={composeDisabled}
            title={composeDisabled ? "No inbox available" : "New message"}
            aria-label="New message"
          >
            <ComposeIcon size={18} aria-hidden="true" />
          </button>
        )}
        {showFolderNav && (
          <MailFolderNav
            activeFolder={activeFolder}
            onSelectFolder={setActiveFolder}
            onShowAttachments={onOpenFiles}
            filesActive={viewMode === "files"}
            accountId={activeAccount}
            rail
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={`email-sidebar${drawer ? " email-sidebar--drawer" : onToggleMenu ? " email-sidebar--pane" : ""}`}
      style={
        onToggleMenu && !drawer
          ? // In a pane the expanded menu opens OVER the list: the negative
            // margin keeps the rail's footprint, so the list and its toolbar
            // (pager included) don't move or wrap.
            { width, marginRight: RAIL_WIDTH_PX - width }
          : { width }
      }
    >
      {onToggleMenu && <MenuToggle expanded onClick={onToggleMenu} />}
      {showComposeButton && (
        <button
          className="compose-btn"
          onClick={onCompose}
          disabled={composeDisabled}
          data-tooltip={composeDisabled ? "No inbox available" : "New message"}
        >
          <ComposeIcon size={16} aria-hidden="true" />
          New message
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
                        <RenameIcon size={15} aria-hidden="true" />
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
        <MailFolderNav
          activeFolder={activeFolder}
          onSelectFolder={setActiveFolder}
          onShowAttachments={onOpenFiles}
          filesActive={viewMode === "files"}
          accountId={activeAccount}
        />
      )}
    </div>
  );
};
