import React, { useEffect, useMemo, useRef, useState } from "react";
import { EmailFolder, EmailItem, STUB_EMAIL_FOLDERS } from "./types";
import { FolderChips } from "./FolderChips";
import { AttachmentIcon, EmailsIcon, MailOpenIcon, TrashIcon } from "../icons";
import { useGlobalSearch } from "../search/SearchContext";
import { fmtListTimestamp } from "../utils/datetime";

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
  // `accountsLoaded` distinguishes "no accounts" from "not fetched yet", so the
  // connect-an-account empty state never flashes at users who do have mailboxes.
  hasAccounts?: boolean;
  accountsLoaded?: boolean;
  // Keeps the bulk/folder-tab chrome from flashing in during the accounts fetch.
  showChrome?: boolean;
  // Only personal users and org owners may connect mailboxes; everyone else sees
  // the empty state without a CTA.
  canAddAccount?: boolean;
  onAddAccount?: () => void;
  // Folder tabs inline in the bulk bar, for org/platform pages that hide the email
  // sidebar but still need to reach Sent.
  showFolderTabs?: boolean;
  onSelectFolder?: (folder: EmailFolder) => void;
  // Omitted by embeddings that don't host the Files panel.
  onShowAttachments?: () => void;
}

// Folders with no backing query. Important / Updates / Social are not stubs: they
// are filtered server-side off the synced Gmail category labels.
const STUB_FOLDER_LABELS: Record<string, string> = {
  spam: "Spam",
  drafts: "Drafts",
};

function formatMobileTime(value: string) {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay && now.getTime() - date.getTime() < 10 * 60 * 1000) {
    return "Now";
  }
  return fmtListTimestamp(date);
}

// Strip the "<addr>" tail from a sender header. Matches the home dashboard's
// formatting so the inbox and the home preview read the same.
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
  hasAccounts = true,
  accountsLoaded = true,
  showChrome = true,
  canAddAccount = false,
  onAddAccount,
  showFolderTabs = false,
  onSelectFolder,
  onShowAttachments,
}) => {
  const isStubFolder = activeFolder
    ? (STUB_EMAIL_FOLDERS as ReadonlyArray<string>).includes(activeFolder)
    : false;
  const showNoAccounts = accountsLoaded && !hasAccounts;
  const { searchQuery, setSearchQuery } = useGlobalSearch();

  const [checkedIds, setCheckedIds] = useState<Set<number>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkHint, setBulkHint] = useState<string | null>(null);
  // Client-side filter over the already-loaded `emails`, so it triggers no re-fetch
  // and Show more still pages older mail in chronological order.
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);

  // Signal/Noise are inbox sub-views selected from the folder chips; both render
  // empty for now (their backend filtering isn't wired up).
  const isEmptySubView = activeFolder === "signal" || activeFolder === "noise";

  const visibleEmails = useMemo(
    () => (showUnreadOnly ? emails.filter((e) => e.is_read === false) : emails),
    [emails, showUnreadOnly]
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
        : new Set(visibleEmails.map((e) => e.id))
    );
  };

  const allChecked = useMemo(
    () => visibleEmails.length > 0 && checkedIds.size === visibleEmails.length,
    [visibleEmails.length, checkedIds.size]
  );
  const someChecked = checkedIds.size > 0 && !allChecked;

  // Gmail-style select dropdown (checkbox + caret): pick a subset of the
  // currently-visible rows. `Starred`/`Unstarred` are omitted — emails aren't
  // starrable in this app.
  const [selectMenuOpen, setSelectMenuOpen] = useState(false);
  const selectMenuRef = useRef<HTMLDivElement | null>(null);

  const selectBy = (pred: (email: EmailItem) => boolean) => {
    setCheckedIds(new Set(visibleEmails.filter(pred).map((e) => e.id)));
    setSelectMenuOpen(false);
  };

  useEffect(() => {
    if (!selectMenuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (
        selectMenuRef.current &&
        event.target instanceof Node &&
        !selectMenuRef.current.contains(event.target)
      ) {
        setSelectMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [selectMenuOpen]);

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
      `Delete ${checkedIds.size} email${checkedIds.size === 1 ? "" : "s"}? This cannot be undone.`
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

  // Infinite scroll. The listener binds once and reads through refs, because
  // `loadMore` is re-created every parent render and would churn it. `inFlightRef`
  // guards duplicates: scroll fires faster than React commits, so the `loadingMore`
  // state alone is not enough.
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
      // Trigger ahead of the bottom edge so the next page usually arrives before
      // the user runs out of rows.
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
        triggerLoadMore();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
    // `triggerLoadMore` reads through refs so it's safe to bind once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the loaded rows don't fill the container it can never be scrolled, so the
  // handler above would never fire. Kick loadMore directly when that happens.
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

      {isListView && showChrome && !showNoAccounts && (
        <div
          className="email-bulk-bar"
          role="toolbar"
          aria-label="Bulk email selection"
        >
          <div className="email-select" ref={selectMenuRef}>
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
            <button
              type="button"
              className="email-select-caret"
              aria-haspopup="menu"
              aria-expanded={selectMenuOpen}
              aria-label="Selection options"
              onClick={() => setSelectMenuOpen((open) => !open)}
            >
              ▾
            </button>
            {selectMenuOpen && (
              <div className="email-select-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="email-select-item"
                  onClick={() => selectBy(() => true)}
                >
                  All
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="email-select-item"
                  onClick={() => selectBy(() => false)}
                >
                  None
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="email-select-item"
                  onClick={() => selectBy((e) => e.is_read === true)}
                >
                  Read
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="email-select-item"
                  onClick={() => selectBy((e) => e.is_read === false)}
                >
                  Unread
                </button>
              </div>
            )}
          </div>
          {checkedIds.size > 0 && (
            <span className="email-bulk-count">{checkedIds.size} selected</span>
          )}
          {showFolderTabs && onSelectFolder && (
            <FolderChips
              activeFolder={activeFolder}
              onSelectFolder={onSelectFolder}
            />
          )}
          <button
            type="button"
            className={`email-bulk-action email-bulk-action--icon${showUnreadOnly ? " is-active" : ""}`}
            onClick={() => {
              setShowUnreadOnly((prev) => !prev);
              // Drop selections the new filter would hide, so the count in the bar
              // always matches what the user can see.
              setCheckedIds(new Set());
            }}
            aria-pressed={showUnreadOnly}
            title={
              showUnreadOnly ? "Show all emails" : "Show only unread emails"
            }
            aria-label={
              showUnreadOnly ? "Show all emails" : "Show only unread emails"
            }
            disabled={bulkBusy}
          >
            <EmailsIcon size={18} />
          </button>
          {onBulkMarkRead && (
            <button
              type="button"
              className="email-bulk-action email-bulk-action--icon"
              onClick={runBulkMarkRead}
              disabled={bulkBusy}
              title="Mark selected as read"
              aria-label="Mark selected as read"
            >
              <MailOpenIcon size={18} />
            </button>
          )}
          {onShowAttachments && (
            <button
              type="button"
              className="email-bulk-action email-bulk-action--icon"
              onClick={onShowAttachments}
              title="Show all attachments across your emails"
              aria-label="Show all attachments across your emails"
            >
              <AttachmentIcon size={18} />
            </button>
          )}
          {onBulkDelete && (
            <button
              type="button"
              className="email-bulk-action email-bulk-action--danger email-bulk-action--icon"
              onClick={runBulkDelete}
              disabled={bulkBusy}
              title="Delete selected"
              aria-label="Delete selected"
            >
              <TrashIcon size={18} />
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

      {showNoAccounts && canAddAccount ? (
        <div className="email-folder-placeholder" role="status">
          <div className="email-folder-placeholder-icon" aria-hidden="true">
            📭
          </div>
          <strong>No email accounts connected yet</strong>
          <span>
            {canAddAccount
              ? "Connect a mailbox to start importing and sending email. We support Gmail, Outlook, IMAP and more."
              : "No mailboxes have been shared with you yet. Ask an organization owner to grant you access."}
          </span>
          {canAddAccount && onAddAccount && (
            <button
              type="button"
              className="email-empty-add-account"
              onClick={onAddAccount}
            >
              ＋ Add email account
            </button>
          )}
        </div>
      ) : isStubFolder ? (
        <div className="email-folder-placeholder" role="status">
          <div className="email-folder-placeholder-icon" aria-hidden="true">
            🛠️
          </div>
          <strong>
            {(activeFolder && STUB_FOLDER_LABELS[activeFolder]) ||
              "This folder"}{" "}
            — coming soon
          </strong>
          <span>
            Gmail-label and Outlook-category sync isn&apos;t wired up yet.
            Switch back to <em>Inbox</em> or <em>Sent</em> to keep working.
          </span>
        </div>
      ) : isEmptySubView ? (
        <div className="email-folder-placeholder" role="status">
          <div className="email-folder-placeholder-icon" aria-hidden="true">
            {activeFolder === "signal" ? "📡" : "🔕"}
          </div>
          <strong>
            {activeFolder === "signal" ? "Signal" : "Noise"} — coming soon
          </strong>
          <span>This view is empty for now.</span>
        </div>
      ) : (
        <>
          {visibleEmails.length === 0 && isListView && showUnreadOnly && (
            <div className="email-bulk-empty">
              No unread emails in this list.
            </div>
          )}

          {visibleEmails.map((email) => (
            <div
              key={email.id}
              className={[
                "email-item",
                email.is_read === false ? "unread" : "read",
                selectedEmailId === email.id ? "active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onOpenEmail(email)}
            >
              <div className="email-top">
                {isListView && (
                  // The read state keeps an empty slot rather than collapsing, so
                  // the row gutter alignment never shifts.
                  <span
                    className={`email-row-unread-dot ${email.is_read === false ? "is-unread" : ""}`}
                    aria-hidden="true"
                  />
                )}
                {isListView && (
                  // The envelope icon and the checkbox share a spot and cross-fade
                  // on hover. stopPropagation so ticking the checkbox doesn't also
                  // open the email.
                  <span
                    className="email-row-toggle"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      className="email-row-checkbox"
                      checked={checkedIds.has(email.id)}
                      onChange={() => toggleChecked(email.id)}
                      aria-label={`Select email "${email.subject || "(No Subject)"}"`}
                    />
                    <span className="email-row-icon" aria-hidden="true">
                      {/* Inline SVG rather than the unicode envelope, which renders
                      as a color emoji on macOS/Windows but a plain glyph on Linux. */}
                      {email.is_read === false ? (
                        <svg
                          viewBox="0 0 16 16"
                          width="14"
                          height="14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect
                            x="1.75"
                            y="3.5"
                            width="12.5"
                            height="9"
                            rx="1.5"
                          />
                          <path d="M2 4.5l6 4.5 6-4.5" />
                        </svg>
                      ) : (
                        <svg
                          viewBox="0 0 16 16"
                          width="14"
                          height="14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M14.5 7v5.75a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5V7a1.5 1.5 0 0 1 .6-1.2l5.25-3.95a1.5 1.5 0 0 1 1.8 0l5.25 3.95A1.5 1.5 0 0 1 14.5 7Z" />
                          <path d="M14.25 7.25L8 11.5 1.75 7.25" />
                        </svg>
                      )}
                    </span>
                  </span>
                )}
                <span className="email-primary">
                  {/* An untouched row has no help-desk state yet — an implicit
                  "open", which the unread style already conveys, so it gets no chip
                  rather than a redundant green one. */}
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
                  <span className="email-list-subject">
                    {email.subject || "(No Subject)"}
                  </span>
                </span>
                <span className="email-row-meta">
                  {email.has_attachments && (
                    <span
                      className="email-attachment-pin"
                      title="Has attachments"
                    >
                      📎
                    </span>
                  )}
                  <span className="email-time">
                    {fmtListTimestamp(email.created_at)}
                  </span>
                </span>
              </div>
              <div className="mobile-email-row">
                <div className="mobile-email-avatar" aria-hidden="true">
                  {(email.sender || email.receiver || "?")
                    .trim()
                    .charAt(0)
                    .toUpperCase()}
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
                  <div className="mobile-email-subject">
                    {email.subject || "(No Subject)"}
                  </div>
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
                <button
                  type="button"
                  className="mobile-email-star"
                  aria-label="Star email"
                >
                  ☆
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {/* Fallback for what infinite scroll can't cover, e.g. a shrunk pane where
          the page fits without overflowing, so there is nothing to scroll. */}
      {!isStubFolder && hasMore && (
        <div className="load-more-wrap">
          {loadingMore ? (
            <span className="load-more-status">Loading more…</span>
          ) : (
            <button
              type="button"
              className="load-more-btn"
              onClick={triggerLoadMore}
            >
              Load more emails
            </button>
          )}
        </div>
      )}
      {!isStubFolder && !hasMore && emails.length > 0 && (
        <div className="load-more-wrap load-more-wrap--end">
          <span className="load-more-status is-end">No more emails.</span>
        </div>
      )}

      {onCompose && (
        <button
          type="button"
          className="mobile-compose-fab"
          onClick={onCompose}
        >
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
