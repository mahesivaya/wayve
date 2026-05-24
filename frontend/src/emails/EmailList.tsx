import React, { useEffect, useMemo, useState } from "react";
import { EmailItem } from "./types";
import { useGlobalSearch } from "../search/SearchContext";

interface EmailListProps {
  emails: EmailItem[];
  selectedEmailId: number | null;
  onOpenEmail: (email: EmailItem) => void;
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
  onCompose?: () => void;
  width?: number;
  isListView?: boolean;
  onBulkMarkRead?: (ids: number[]) => Promise<void> | void;
  onBulkDelete?: (ids: number[]) => Promise<void> | void;
}

function formatMobileTime(value: string) {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay && now.getTime() - date.getTime() < 10 * 60 * 1000) {
    return "Now";
  }
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export const EmailList: React.FC<EmailListProps> = ({
  emails,
  selectedEmailId,
  onOpenEmail,
  hasMore,
  loadMore,
  loadingMore,
  onCompose,
  width,
  isListView = false,
  onBulkMarkRead,
  onBulkDelete,
}) => {
  const { searchQuery, setSearchQuery } = useGlobalSearch();

  // Per-row bulk-select state for list view. Bulk action callbacks are
  // optional — when provided, Mark read / Delete buttons appear in the
  // bar. Selection is cleared on successful action completion.
  const [checkedIds, setCheckedIds] = useState<Set<number>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Inline toast shown when the user clicks Mark read / Delete with no
  // selection. Auto-dismisses after ~2s so the bar settles back to normal.
  const [bulkHint, setBulkHint] = useState<string | null>(null);

  useEffect(() => {
    if (!bulkHint) return;
    const timer = window.setTimeout(() => setBulkHint(null), 2200);
    return () => window.clearTimeout(timer);
  }, [bulkHint]);

  const toggleChecked = (id: number) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearChecked = () => setCheckedIds(new Set());

  const toggleAll = () => {
    setCheckedIds((prev) =>
      prev.size === emails.length && emails.length > 0
        ? new Set()
        : new Set(emails.map((e) => e.id)),
    );
  };

  const allChecked = useMemo(
    () => emails.length > 0 && checkedIds.size === emails.length,
    [emails.length, checkedIds.size],
  );
  const someChecked = checkedIds.size > 0 && !allChecked;

  const runBulkMarkRead = async () => {
    if (!onBulkMarkRead) return;
    if (checkedIds.size === 0) {
      setBulkHint("Select at least one email to mark as read.");
      return;
    }
    setBulkBusy(true);
    try {
      await onBulkMarkRead(Array.from(checkedIds));
      setCheckedIds(new Set());
    } finally {
      setBulkBusy(false);
    }
  };

  const runBulkDelete = async () => {
    if (!onBulkDelete) return;
    if (checkedIds.size === 0) {
      setBulkHint("Select at least one email to delete.");
      return;
    }
    const ok = window.confirm(
      `Delete ${checkedIds.size} email${checkedIds.size === 1 ? "" : "s"}? This cannot be undone.`,
    );
    if (!ok) return;
    setBulkBusy(true);
    try {
      await onBulkDelete(Array.from(checkedIds));
      setCheckedIds(new Set());
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="email-list" style={width ? { width } : undefined}>
      <div className="mobile-mail-topbar">
        <button type="button" className="mobile-mail-menu" aria-label="Menu">
          ☰
        </button>
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search in mail"
          aria-label="Search in mail"
        />
        <div className="mobile-mail-avatar" aria-hidden="true">
          M
        </div>
      </div>
      <div className="mobile-mail-label">Inbox</div>

      {isListView && (
        <div className="email-bulk-bar" role="toolbar" aria-label="Bulk email selection">
          <input
            type="checkbox"
            className="email-bulk-master"
            checked={allChecked}
            ref={(el) => {
              if (el) el.indeterminate = someChecked;
            }}
            onChange={toggleAll}
            aria-label={allChecked ? "Clear selection" : "Select all emails"}
          />
          {checkedIds.size > 0 ? (
            <span className="email-bulk-count">{checkedIds.size} selected</span>
          ) : (
            <span className="email-bulk-hint">Select emails</span>
          )}
          {onBulkMarkRead && (
            <button
              type="button"
              className="email-bulk-action"
              onClick={runBulkMarkRead}
              disabled={bulkBusy}
              title="Mark selected as read"
            >
              Mark read
            </button>
          )}
          {onBulkDelete && (
            <button
              type="button"
              className="email-bulk-action email-bulk-action--danger"
              onClick={runBulkDelete}
              disabled={bulkBusy}
              title="Delete selected"
            >
              Delete
            </button>
          )}
          {checkedIds.size > 0 && (
            <button
              type="button"
              className="email-bulk-clear"
              onClick={clearChecked}
              disabled={bulkBusy}
            >
              Clear
            </button>
          )}
          {bulkHint && (
            <span className="email-bulk-toast" role="status">
              {bulkHint}
            </span>
          )}
        </div>
      )}

      {emails.map((email) => (
        <div
          key={email.id}
          className={[
            "email-item",
            email.is_read === false ? "unread" : "read",
            selectedEmailId === email.id ? "active" : "",
          ].filter(Boolean).join(" ")}
          onClick={() => onOpenEmail(email)}
        >
          <div className="email-top">
            {isListView && (
              <input
                type="checkbox"
                className="email-row-checkbox"
                checked={checkedIds.has(email.id)}
                onChange={() => toggleChecked(email.id)}
                onClick={(event) => event.stopPropagation()}
                aria-label={`Select email "${email.subject || "(No Subject)"}"`}
              />
            )}
            <span className="email-primary">
              {/* Shared-inbox workflow chip. Only renders when the row
                  came from a shared account AND has been touched at
                  least once (no chip = no help-desk state yet, i.e.
                  implicit "open" — surfaced by the row's unread style
                  rather than a redundant green chip on every mail). */}
              {email.is_shared && email.inbox_status && (
                <span className={`inbox-status-chip ${email.inbox_status}`}>
                  {email.inbox_status}
                </span>
              )}
              <span className="email-list-subject">{email.subject || "(No Subject)"}</span>
            </span>
            <span className="email-row-meta">
              {email.has_attachments && <span className="email-attachment-pin" title="Has attachments">📎</span>}
              <span className="email-time">
                {new Date(email.created_at).toLocaleTimeString()}
              </span>
            </span>
          </div>
          <div className="mobile-email-row">
            <div className="mobile-email-avatar" aria-hidden="true">
              {(email.sender || email.receiver || "?").trim().charAt(0).toUpperCase()}
            </div>
            <div className="mobile-email-content">
              <div className="mobile-email-sender-line">
                <span className="mobile-email-sender">
                  {email.sender || email.receiver || "Unknown sender"}
                </span>
                <span className="mobile-email-time">
                  {formatMobileTime(email.created_at)}
                </span>
              </div>
              <div className="mobile-email-subject">{email.subject || "(No Subject)"}</div>
              <div className="mobile-email-preview">
                {email.preview || email.body || "No preview available"}
              </div>
              {email.has_attachments && (
                <div className="mobile-email-attachment">
                  <span aria-hidden="true">PDF</span>
                  Attachment
                </div>
              )}
            </div>
            <button type="button" className="mobile-email-star" aria-label="Star email">
              ☆
            </button>
          </div>
        </div>
      ))}

      {hasMore && (
        <div className="load-more-wrap">
          <button className="load-more-btn" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "Loading..." : "Show more emails"}</button>
        </div>
      )}

      {onCompose && (
        <button type="button" className="mobile-compose-fab" onClick={onCompose}>
          ✎ <span>Compose</span>
        </button>
      )}
      <div className="mobile-mail-bottom-nav" aria-hidden="true">
        <span className="active">✉</span>
        <span>□</span>
        <span>♚</span>
        <span>▭</span>
      </div>
    </div>
  );
};
