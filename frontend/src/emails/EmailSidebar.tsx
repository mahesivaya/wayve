import React, { useState } from "react";
import { EmailAccount, EmailFolder } from "./types";
import ProviderPicker from "./ProviderPicker";
import type { ProviderId } from "./providers";

interface EmailSidebarProps {
  accounts: EmailAccount[];
  activeAccount: number | null;
  setActiveAccount: (id: number | null) => void;
  activeFolder: EmailFolder;
  setActiveFolder: (folder: EmailFolder) => void;
  viewMode: "email" | "files";
  onOpenFiles: () => void;
  // Single dispatcher — the parent decides what to do per provider id, so
  // adding Yahoo/Exchange later doesn't change this component's surface.
  onAddProvider: (provider: ProviderId) => void;
  onCompose: () => void;
  composeDisabled: boolean;
  width: number;
  onRenameAccount: (id: number, displayName: string | null) => Promise<void>;
  showAccountControls?: boolean;
}

export const EmailSidebar: React.FC<EmailSidebarProps> = ({
  accounts,
  activeAccount,
  setActiveAccount,
  activeFolder,
  setActiveFolder,
  viewMode,
  onOpenFiles,
  onAddProvider,
  onCompose,
  composeDisabled,
  width,
  onRenameAccount,
  showAccountControls = true,
}) => {
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [savingAccountId, setSavingAccountId] = useState<number | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

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
      setRenameError(err instanceof Error ? err.message : "Could not save account name");
    } finally {
      setSavingAccountId(null);
    }
  };

  return (
    <div className="sidebar" style={{ width }}>
      <button
        className="compose-btn"
        onClick={onCompose}
        disabled={composeDisabled}
        title={composeDisabled ? "No inbox available" : "Compose"}
      >
        Compose
      </button>

      {showAccountControls && (
        <>
          <div className="mail-section-header">
            <span className="mail-section-title">Accounts</span>
            <button
              type="button"
              className="mail-section-action"
              onClick={() => setPickerOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
              aria-label="Add account"
              title="Add account"
            >
              +
            </button>
          </div>

          <nav className="mail-filters" aria-label="Mail accounts">
            <button
              className={`filter-btn ${activeAccount === null ? "active" : ""}`}
              onClick={() => setActiveAccount(null)}
            >
              🌐 All Accounts
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
                {renameError && <span className="account-rename-error">{renameError}</span>}
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="account-filter-main"
                  onClick={() => setActiveAccount(acc.id)}
                  title={acc.is_shared ? `Shared inbox · ${acc.email}` : acc.email}
                >
                  <span className="account-filter-label">
                    {displayName}
                    {acc.is_shared && (
                      <span className="account-shared-chip" aria-label="Shared inbox">
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
        </>
      )}

      {/* Mount only while open — keeps the picker's state fresh each time
          and avoids reset-on-close juggling. */}
      {showAccountControls && pickerOpen && (
        <ProviderPicker
          onClose={() => setPickerOpen(false)}
          onSelect={(provider) => {
            setPickerOpen(false);
            onAddProvider(provider);
          }}
        />
      )}

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
          className={`filter-btn ${viewMode === "files" ? "active" : ""}`}
          onClick={onOpenFiles}
        >
          📎 Attachments
        </button>
      </nav>
    </div>
  );
};
