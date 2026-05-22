import React, { useState } from "react";
import { EmailAccount } from "./types";
import ProviderPicker from "./ProviderPicker";
import type { ProviderId } from "./providers";

interface EmailSidebarProps {
  accounts: EmailAccount[];
  activeAccount: number | null;
  setActiveAccount: (id: number | null) => void;
  activeFolder: "inbox" | "sent";
  setActiveFolder: (folder: "inbox" | "sent") => void;
  viewMode: "email" | "files";
  onOpenFiles: () => void;
  // Single dispatcher — the parent decides what to do per provider id, so
  // adding Yahoo/Exchange later doesn't change this component's surface.
  onAddProvider: (provider: ProviderId) => void;
  onCompose: () => void;
  composeDisabled: boolean;
  width: number;
  onRenameAccount: (id: number, displayName: string | null) => Promise<void>;
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
        title={composeDisabled ? "Add an account first" : "Compose"}
      >
        Compose
      </button>

      <div className="mail-section-title">Accounts</div>

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

      <button
        className="add-email-btn"
        onClick={() => setPickerOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
      >
        ➕ Add more accounts
      </button>

      {/* Mount only while open — keeps the picker's state fresh each time
          and avoids reset-on-close juggling. */}
      {pickerOpen && (
        <ProviderPicker
          onClose={() => setPickerOpen(false)}
          onSelect={(provider) => {
            setPickerOpen(false);
            onAddProvider(provider);
          }}
        />
      )}

      <div className="mail-section-title">Folders</div>

      <div className="mail-filters">
        <button className={`filter-btn ${activeFolder === "inbox" && viewMode === "email" ? "active" : ""}`} onClick={() => setActiveFolder("inbox")}>📥 Inbox</button>
        <button className={`filter-btn ${activeFolder === "sent" && viewMode === "email" ? "active" : ""}`} onClick={() => setActiveFolder("sent")}>📤 Sent</button>
        <button
          className={`filter-btn ${viewMode === "files" ? "active" : ""}`}
          onClick={onOpenFiles}
        >
          📎 Attachments
        </button>
      </div>
    </div>
  );
};
