import React, { useEffect, useMemo, useRef, useState } from "react";
import { EmailFolder, EmailItem, STUB_EMAIL_FOLDERS } from "./types";
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
  activeFolder?: EmailFolder;
}

const STUB_FOLDER_LABELS: Record<string, string> = {
  important: "Important",
  updates: "Updates",
  spam: "Spam",
  drafts: "Drafts",
  social: "Social",
};

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

// Strip the "<addr>" tail from a sender header so the list shows a
// clean display name. Matches the formatting used in the personal-home
// dashboard so the inbox and the home preview read the same.
function displaySender(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw) return "Unknown sender";
  const match = raw.match(/^"?([^"<]+?)"?\s*<.*>$/);
  if (match) return match[1].trim();
  if (raw.includes("@")) return raw.split("@")[0];
  return raw;
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
  activeFolder,
}) => {
  const isStubFolder = activeFolder
    ? (STUB_EMAIL_FOLDERS as ReadonlyArray<string>).includes(activeFolder)
    : false;
  const { searchQuery, setSearchQuery } = useGlobalSearch();

  // Per-row bulk-select state for list view. Bulk action callbacks are
  // optional — when provided, Mark read / Delete buttons appear in the
  // bar. Selection is cleared on successful action completion.
  const [checkedIds, setCheckedIds] = useState<Set<number>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Inline toast shown when the user clicks Mark read / Delete with no
  // selection. Auto-dismisses after ~2s so the bar settles back to normal.
  const [bulkHint, setBulkHint] = useState<string | null>(null);
  // Client-side filter; doesn't trigger a backend re-fetch. Filters over
  // the already-loaded `emails` so Show more still pulls older mail in
  // chronological order — toggling Unread later applies to the full set.
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);

  const visibleEmails = useMemo(
    () => (showUnreadOnly ? emails.filter((e) => e.is_read === false) : emails),
    [emails, showUnreadOnly],
  );

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
      prev.size === visibleEmails.length && visibleEmails.length > 0
        ? new Set()
        : new Set(visibleEmails.map((e) => e.id)),
    );
  };

  const allChecked = useMemo(
    () => visibleEmails.length > 0 && checkedIds.size === visibleEmails.length,
    [visibleEmails.length, checkedIds.size],
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

  // Infinite scroll: when the user nears the bottom of the list, pull
  // the next page automatically. Replaces the explicit "Show more
  // emails" button so browsing feels continuous.
  //
  // Implementation notes:
  // - The scroll listener is bound ONCE (no deps) so we don't churn
  //   add/remove on every render of the parent — which was happening
  //   before because `loadMore` is re-created each render and was in
  //   the effect's dep array. The handler reads the latest hasMore /
  //   loadingMore / loadMore via refs instead.
  // - An `inFlightRef` ref guards against duplicate calls before
  //   `loadingMore` state updates (scroll fires faster than React
  //   commits, so the state-only guard wasn't reliable).
  // - A second effect auto-triggers loadMore right after emails
  //   change when the container isn't yet scrollable — otherwise a
  //   short initial page would never let the user reach a scroll
  //   bottom, and loadMore would never fire.
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const inFlightRef = useRef(false);
  const hasMoreRef = useRef(hasMore);
  const loadingMoreRef = useRef(loadingMore);
  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);
  useEffect(() => {
    loadingMoreRef.current = loadingMore;
    if (!loadingMore) inFlightRef.current = false;
  }, [loadingMore]);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  const triggerLoadMore = () => {
    if (inFlightRef.current) return;
    if (!hasMoreRef.current || loadingMoreRef.current) return;
    inFlightRef.current = true;
    loadMoreRef.current();
  };

  useEffect(() => {
    const el = listScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      // Trigger when the bottom edge is within ~400px — far enough
      // ahead that the next page often arrives before the user runs
      // out of rows.
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
        triggerLoadMore();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
    // `triggerLoadMore` reads through refs so it's safe to bind once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After emails change (or the list first renders), check whether the
  // container has enough content to actually scroll. If not, kick
  // loadMore so the user can keep paging without needing to fight a
  // non-scrollable list. This fixes the "didn't get any next emails"
  // case where the initial 25 rows don't fill the visible area on a
  // tall viewport.
  useEffect(() => {
    const el = listScrollRef.current;
    if (!el) return;
    if (!hasMore || loadingMore) return;
    if (emails.length === 0) return;
    if (el.scrollHeight <= el.clientHeight + 1) {
      triggerLoadMore();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emails.length, hasMore, loadingMore]);

  return (
    <div
      ref={listScrollRef}
      className="email-list"
      style={width ? { width } : undefined}
    >
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
            <span className="email-bulk-hint">Select all emails</span>
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
          <button
            type="button"
            className={`email-bulk-action${showUnreadOnly ? " is-active" : ""}`}
            onClick={() => {
              setShowUnreadOnly((prev) => !prev);
              // Drop selections that the new filter would hide so the count
              // displayed in the bar always matches what the user can see.
              setCheckedIds(new Set());
            }}
            aria-pressed={showUnreadOnly}
            title={showUnreadOnly ? "Show all emails" : "Show only unread emails"}
            disabled={bulkBusy}
          >
            {showUnreadOnly ? "Showing unread" : "Show unread"}
          </button>
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

      {isStubFolder ? (
        <div className="email-folder-placeholder" role="status">
          <div className="email-folder-placeholder-icon" aria-hidden="true">🛠️</div>
          <strong>
            {(activeFolder && STUB_FOLDER_LABELS[activeFolder]) || "This folder"} —
            coming soon
          </strong>
          <span>
            Gmail-label and Outlook-category sync isn&apos;t wired up yet.
            Switch back to <em>Inbox</em> or <em>Sent</em> to keep working.
          </span>
        </div>
      ) : (
        <>
          {visibleEmails.length === 0 && isListView && showUnreadOnly && (
            <div className="email-bulk-empty">No unread emails in this list.</div>
          )}

          {visibleEmails.map((email) => (
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
              {isListView && (
                <span className="email-list-sender">
                  {displaySender(email.sender || email.receiver)}
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
        </>
      )}

      {/* Infinite-scroll status row. Renders a faint "Loading more…"
          while the next page is in flight, and an "End of inbox" hint
          when there's nothing left to fetch. Replaces the explicit
          "Show more emails" button. */}
      {!isStubFolder && hasMore && loadingMore && (
        <div className="load-more-wrap">
          <span className="load-more-status">Loading more…</span>
        </div>
      )}
      {!isStubFolder && !hasMore && emails.length > 0 && (
        <div className="load-more-wrap">
          <span className="load-more-status is-end">No more emails.</span>
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
