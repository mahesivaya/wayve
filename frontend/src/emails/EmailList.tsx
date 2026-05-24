import React, { useMemo, useState } from "react";
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
}) => {
  const { searchQuery, setSearchQuery } = useGlobalSearch();

  // Per-row bulk-select state for list view. Lives locally because no
  // upstream action consumes it yet — the checkboxes are visual + provide
  // a count so future bulk-action buttons (delete, mark-read) can hook in
  // without restructuring this component.
  const [checkedIds, setCheckedIds] = useState<Set<number>>(() => new Set());

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
            <>
              <span className="email-bulk-count">{checkedIds.size} selected</span>
              <button
                type="button"
                className="email-bulk-clear"
                onClick={clearChecked}
              >
                Clear
              </button>
            </>
          ) : (
            <span className="email-bulk-hint">Select all emails</span>
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
