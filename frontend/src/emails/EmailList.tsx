import React, { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EmailFolder, EmailItem, STUB_EMAIL_FOLDERS } from "./types";
import { FolderChips } from "./FolderChips";
import {
  AttachmentIcon,
  EmailsIcon,
  InviteIcon,
  MailOpenIcon,
  RestoreIcon,
  SnoozeIcon,
  StarIcon,
  TrashIcon,
  UnsnoozeIcon,
} from "../icons";
import { SnoozeMenu } from "./SnoozeMenu";
import { canSnoozeIn, formatSnoozeTime } from "./snoozePresets";
import { useGlobalSearch } from "../search/SearchContext";
import { useListScrollMemory } from "./useListScrollMemory";
import { fmtListTimestamp } from "../utils/datetime";
import {
  conversationSenders,
  isConversation,
  isStarred,
  isUnread,
} from "./conversation";
import { listFolder } from "./searchScope";

interface EmailListProps {
  emails: EmailItem[];
  selectedEmailId: number | null;
  onOpenEmail: (email: EmailItem) => void;
  hasMore: boolean;
  // May be async: `triggerLoadMore` clears its in-flight guard when the
  // returned promise settles, so a call the parent rejects can't wedge paging.
  loadMore: () => void | Promise<void>;
  loadingMore: boolean;
  width?: number;
  isListView?: boolean;
  // Accepted but no longer read: the toolbar button that called it is gone and
  // marking read is a per-row action now. Kept so Emails.tsx keeps compiling —
  // drop both sides together.
  onBulkMarkRead?: (ids: number[]) => Promise<void> | void;
  onBulkDelete?: (ids: number[]) => Promise<void> | void;
  // In Trash: restore the selected rows in one request.
  onBulkRestore?: (ids: number[]) => Promise<void> | void;
  // Per-row hover actions: toggle a single email's read state.
  onMarkRead?: (id: number) => Promise<void> | void;
  onMarkUnread?: (id: number) => Promise<void> | void;
  // Per-row hover actions: move a row to Trash, or (in the Trash folder) back.
  // Both reject on failure, which the list shows.
  onDelete?: (id: number) => Promise<unknown>;
  onRestore?: (id: number) => Promise<unknown>;
  // The star on every row, as in Gmail. Rejects on failure, which the list
  // shows (the star itself flips back in useEmailInbox).
  onToggleStar?: (id: number) => Promise<unknown>;
  // Snooze a row until a moment picked from the row's menu (the inbox views
  // hide it until then), or in the Snoozed folder end it. Both reject on
  // failure, which the list shows.
  onSnooze?: (id: number, until: Date) => Promise<unknown>;
  onUnsnooze?: (id: number) => Promise<unknown>;
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
  // Identifies which list this is (account + folder), so the scroll offset
  // restored on remount belongs to the rows being shown. Omitting it keeps the
  // memory per-search-term only, which is right for a lone embedded list.
  scrollKey?: string;
  // Where the "1–50 ‹ ›" pager renders: the page toolbar's slot when there is
  // one, otherwise inline at the bottom of the list.
  pagerSlot?: HTMLElement | null;
  // Rows in this whole view, from the server, for "page / pages". Null when
  // unknown; the pager then shows only the page number.
  total?: number | null;
  // Your mailbox addresses, shown as "me" among a conversation's senders.
  ownAddresses?: string[];
}

// Folders with no backing query. Important / Updates / Social are not stubs: they
// are filtered server-side off the synced Gmail category labels.
const STUB_FOLDER_LABELS: Record<string, string> = {
  spam: "Spam",
  drafts: "Drafts",
};

export const EMAIL_PAGE_SIZE = 50;

// The page each list (account + folder + search) was on. Module state for the
// same reason as useListScrollMemory: in list view, opening an email unmounts
// the list, and Back should return to the same page, not page one.
const savedPages = new Map<string, number>();

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
  width,
  isListView = false,
  onBulkDelete,
  onBulkRestore,
  onMarkRead,
  onMarkUnread,
  onDelete,
  onRestore,
  onToggleStar,
  onSnooze,
  onUnsnooze,
  activeFolder,
  hasAccounts = true,
  accountsLoaded = true,
  showChrome = true,
  canAddAccount = false,
  onAddAccount,
  showFolderTabs = false,
  onSelectFolder,
  onShowAttachments,
  scrollKey = "emails",
  pagerSlot = null,
  total = null,
  ownAddresses = [],
}) => {
  const isStubFolder = activeFolder
    ? (STUB_EMAIL_FOLDERS as ReadonlyArray<string>).includes(activeFolder)
    : false;
  const showNoAccounts = accountsLoaded && !hasAccounts;
  // Read-only here: the query is set from the page toolbar's search box and is
  // only needed as part of the scroll-memory key below.
  const { searchQuery } = useGlobalSearch();
  // A search reads all mail (see listFolder), so say so: the results include
  // mail this folder doesn't list.
  const searchingAllMail =
    searchQuery.trim() !== "" &&
    listFolder(activeFolder ?? "inbox", searchQuery) === "all";

  const [checkedIds, setCheckedIds] = useState<Set<number>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkHint, setBulkHint] = useState<string | null>(null);
  // Gmail-style pages of EMAIL_PAGE_SIZE rows over the rows loaded so far. The
  // server still hands out keyset batches (`loadMore`); the effect below keeps
  // one row beyond this page loaded, so Next knows whether there is a next
  // page and is instant when there is.
  const listKey = `${scrollKey}|${searchQuery}`;
  const [pageState, setPageState] = useState(() => ({
    key: listKey,
    page: savedPages.get(listKey) ?? 0,
  }));
  const requestedPage =
    pageState.key === listKey ? pageState.page : (savedPages.get(listKey) ?? 0);
  const lastPage = Math.max(0, Math.ceil(emails.length / EMAIL_PAGE_SIZE) - 1);
  // Clamped: rows can leave (delete, snooze) and empty the last page.
  const page = Math.min(requestedPage, lastPage);
  const pageStart = page * EMAIL_PAGE_SIZE;
  const visibleEmails = emails.slice(pageStart, pageStart + EMAIL_PAGE_SIZE);
  const hasNextPage = emails.length > pageStart + EMAIL_PAGE_SIZE;

  useEffect(() => {
    if (!bulkHint) return;
    const timer = window.setTimeout(() => setBulkHint(null), 2200);
    return () => window.clearTimeout(timer);
  }, [bulkHint]);

  // Rows with a delete/restore in flight, so a double-click sends one request.
  const [busyIds, setBusyIds] = useState<Set<number>>(() => new Set());
  // Shown above the rows rather than in the bulk bar, which split view hides.
  const [rowError, setRowError] = useState<string | null>(null);

  useEffect(() => {
    if (!rowError) return;
    const timer = window.setTimeout(() => setRowError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [rowError]);

  // Trash / Restore on one row. The row then leaves this list, so it leaves
  // the selection too — otherwise "1 selected" would count a row no longer
  // shown, and a bulk delete would send it again.
  const runRowAction = async (
    id: number,
    action: (id: number) => Promise<unknown>,
    failure: string
  ) => {
    if (busyIds.has(id)) return;
    setBusyIds((prev) => new Set(prev).add(id));
    setRowError(null);
    try {
      await action(id);
      setCheckedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (err) {
      setRowError(err instanceof Error ? err.message : failure);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Rows whose star click is in flight: a second click before the first
  // settles would race its rollback.
  const [starBusy, setStarBusy] = useState<Set<number>>(() => new Set());
  const toggleStar = async (id: number) => {
    if (!onToggleStar || starBusy.has(id)) return;
    setStarBusy((prev) => new Set(prev).add(id));
    try {
      await onToggleStar(id);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to star email");
    } finally {
      setStarBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };
  const star = (email: EmailItem, className: string) => {
    const starred = isStarred(email);
    return (
      <button
        type="button"
        className={`${className}${starred ? " is-starred" : ""}`}
        aria-label={starred ? "Starred" : "Not starred"}
        aria-pressed={starred}
        data-tooltip={starred ? "Starred" : "Not starred"}
        onClick={(event) => {
          // A star click must not open the email.
          event.stopPropagation();
          void toggleStar(email.id);
        }}
      >
        <StarIcon size={16} fill={starred ? "currentColor" : "none"} />
      </button>
    );
  };

  // The row whose snooze menu is open, and the button it hangs from. The menu
  // lives on <body> (see SnoozeMenu), so pointing at it drops the row's
  // :hover; `menu-open` keeps that row's actions showing meanwhile.
  const [snoozeFor, setSnoozeFor] = useState<{
    id: number;
    anchor: HTMLElement;
  } | null>(null);
  // Snoozed rows offer Unsnooze instead of Snooze, and show when they return.
  const inSnoozed = activeFolder === "snoozed";
  const rowSnooze = canSnoozeIn(activeFolder) ? onSnooze : undefined;
  const rowUnsnooze = inSnoozed ? onUnsnooze : undefined;

  // Trash rows offer Restore instead of Delete: deleting them again would do
  // nothing, and there is no permanent delete (see routes/email.rs).
  const inTrash = activeFolder === "trash";
  const rowDelete = inTrash ? undefined : onDelete;
  const rowRestore = inTrash ? onRestore : undefined;

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
  // currently-visible rows.
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

  const runBulkDelete = async () => {
    if (!onBulkDelete) return;
    if (checkedIds.size === 0) {
      setBulkHint("Select at least one email to delete.");
      return;
    }
    const ok = window.confirm(
      `Move ${checkedIds.size} conversation${checkedIds.size === 1 ? "" : "s"} to Trash?`
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

  // No confirm: restoring only takes mail out of Trash, nothing is lost.
  const runBulkRestore = async () => {
    if (!onBulkRestore || checkedIds.size === 0) return;
    setBulkBusy(true);
    try {
      await onBulkRestore(Array.from(checkedIds));
      setCheckedIds(new Set());
    } finally {
      setBulkBusy(false);
    }
  };

  const listScrollRef = useRef<HTMLDivElement | null>(null);

  const goToPage = (next: number) => {
    savedPages.set(listKey, next);
    setPageState({ key: listKey, page: next });
    // Selection is per page, as in Gmail: a checked row on another page would
    // be acted on unseen.
    setCheckedIds(new Set());
    if (listScrollRef.current) listScrollRef.current.scrollTop = 0;
  };

  // Keep rows loaded up to one past this page: that fills a short page and
  // tells Next whether a next page exists. A batch the parent de-dups to
  // nothing leaves `emails.length` unchanged, and asking again from the same
  // cursor would return the same batch forever, so each (list, length) is
  // asked for at most once.
  const lastAskedRef = useRef<string | null>(null);
  useEffect(() => {
    if (isStubFolder || !hasMore || loadingMore || emails.length === 0) return;
    if (emails.length > pageStart + EMAIL_PAGE_SIZE) return;
    const ask = `${listKey}|${emails.length}`;
    if (lastAskedRef.current === ask) return;
    lastAskedRef.current = ask;
    void loadMore();
  }, [
    isStubFolder,
    hasMore,
    loadingMore,
    emails.length,
    pageStart,
    listKey,
    loadMore,
  ]);

  // Opening an email unmounts this pane in list view, so the offset has to be
  // kept outside the component and put back when Back mounts a fresh one.
  useListScrollMemory(listScrollRef, `${scrollKey}|${searchQuery}`);

  // Pages in the whole view. The server total counts synced mail only, and
  // rows can sync in before the next count, so never show fewer pages than
  // are already loaded or reachable.
  const pageCount =
    total === null
      ? null
      : Math.max(
          Math.ceil(total / EMAIL_PAGE_SIZE),
          page + (hasNextPage ? 2 : 1)
        );
  const showPager =
    !isStubFolder && !showNoAccounts && visibleEmails.length > 0;
  const pager = (
    <nav
      className={`email-pager${pagerSlot ? " email-pager--toolbar" : ""}`}
      aria-label="Pages"
    >
      <span className="email-pager-emails">
        {pageStart + 1}–{pageStart + visibleEmails.length}
      </span>
      <button
        type="button"
        className="email-pager-btn"
        onClick={() => goToPage(page - 1)}
        disabled={page === 0}
        aria-label="Newer"
        data-tooltip="Newer"
      >
        ‹
      </button>
      <span className="email-pager-range" aria-live="polite">
        {pageCount === null ? page + 1 : `${page + 1}/${pageCount}`}
      </span>
      <button
        type="button"
        className="email-pager-btn"
        onClick={() => goToPage(page + 1)}
        disabled={!hasNextPage}
        aria-label="Older"
        data-tooltip={loadingMore && !hasNextPage ? "Loading…" : "Older"}
      >
        ›
      </button>
    </nav>
  );

  return (
    <div
      ref={listScrollRef}
      className="email-list"
      style={width ? { width } : undefined}
    >
      {/* No mobile search bar / "Inbox" caption here: the page toolbar above
          already carries Compose and the global search box, so a second search
          field plus a label only pushed the bulk bar ~90px down the screen. */}
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
                  onClick={() => selectBy((e) => !isUnread(e))}
                >
                  Read
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="email-select-item"
                  onClick={() => selectBy((e) => isUnread(e))}
                >
                  Unread
                </button>
                {onToggleStar && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="email-select-item"
                      onClick={() => selectBy((e) => isStarred(e))}
                    >
                      Starred
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="email-select-item"
                      onClick={() => selectBy((e) => !isStarred(e))}
                    >
                      Unstarred
                    </button>
                  </>
                )}
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
              onShowAttachments={onShowAttachments}
            />
          )}
          {/* The unread-filter and mark-as-read icons that used to sit here are
            gone; both actions stay on the row itself, where they act on the
            email under the pointer rather than on a selection. The attachments
            paperclip is now the "Docs" chip beside Sent, in FolderChips. */}
          {onBulkRestore && checkedIds.size > 0 && (
            <button
              type="button"
              className="email-bulk-action email-bulk-action--icon"
              onClick={runBulkRestore}
              disabled={bulkBusy}
              data-tooltip="Restore selected to inbox"
              aria-label="Restore selected to inbox"
            >
              <RestoreIcon size={18} />
            </button>
          )}
          {onBulkDelete && checkedIds.size > 0 && (
            <button
              type="button"
              className="email-bulk-action email-bulk-action--danger email-bulk-action--icon"
              onClick={runBulkDelete}
              disabled={bulkBusy}
              data-tooltip="Delete selected"
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

      {rowError && (
        <div className="email-row-error" role="alert">
          {rowError}
        </div>
      )}

      {searchingAllMail && !showNoAccounts && (
        <div className="email-search-scope" role="status">
          Searching all mail
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
      ) : (
        <>
          {visibleEmails.map((email) => (
            <div
              key={email.id}
              className={[
                "email-item",
                isUnread(email) ? "unread" : "read",
                selectedEmailId === email.id ? "active" : "",
                snoozeFor?.id === email.id ? "menu-open" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onOpenEmail(email)}
            >
              <div className="email-top">
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
                      {isUnread(email) ? (
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
                {/* Its own grid track in list view, after the checkbox, as in
                    Gmail. The slot stays when there is no star, so the
                    columns after it still line up. */}
                {isListView ? (
                  <span className="email-row-star-slot">
                    {onToggleStar && star(email, "email-row-star")}
                  </span>
                ) : (
                  onToggleStar && star(email, "email-row-star")
                )}
                {/* A direct child of .email-top, not of .email-primary, so it
                    can occupy a grid track of its own and line up with the
                    senders above and below it. */}
                {isListView && (
                  <span className={senderClass("email-list-sender", email)}>
                    <SenderNames email={email} ownAddresses={ownAddresses} />
                    <ConversationCount email={email} />
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
                  {email.is_invite && (
                    <InviteIcon
                      size={14}
                      className="email-invite-mark"
                      aria-label="Meeting invitation"
                      role="img"
                    />
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
                  {inSnoozed && email.snoozed_until ? (
                    <span
                      className="email-time email-snooze-time"
                      title="Back in the inbox at"
                    >
                      <SnoozeIcon size={12} aria-hidden="true" />
                      {formatSnoozeTime(new Date(email.snoozed_until))}
                    </span>
                  ) : (
                    <span className="email-time">
                      {fmtListTimestamp(email.created_at)}
                    </span>
                  )}
                </span>
                {(onMarkRead ||
                  onMarkUnread ||
                  rowDelete ||
                  rowRestore ||
                  rowSnooze ||
                  rowUnsnooze) && (
                  <span
                    className="email-row-actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {rowDelete && (
                      <button
                        type="button"
                        className="email-row-action email-row-action--danger"
                        data-tooltip="Delete"
                        data-tooltip-align="right"
                        aria-label="Delete"
                        disabled={busyIds.has(email.id)}
                        onClick={() =>
                          void runRowAction(
                            email.id,
                            rowDelete,
                            "Failed to delete email"
                          )
                        }
                      >
                        <TrashIcon size={16} />
                      </button>
                    )}
                    {rowRestore && (
                      <button
                        type="button"
                        className="email-row-action"
                        data-tooltip="Restore to inbox"
                        data-tooltip-align="right"
                        aria-label="Restore to inbox"
                        disabled={busyIds.has(email.id)}
                        onClick={() =>
                          void runRowAction(
                            email.id,
                            rowRestore,
                            "Failed to restore email"
                          )
                        }
                      >
                        <RestoreIcon size={16} />
                      </button>
                    )}
                    {isUnread(email)
                      ? onMarkRead && (
                          <button
                            type="button"
                            className="email-row-action"
                            data-tooltip="Mark as read"
                            data-tooltip-align="right"
                            aria-label="Mark as read"
                            onClick={() => void onMarkRead(email.id)}
                          >
                            <MailOpenIcon size={16} />
                          </button>
                        )
                      : onMarkUnread && (
                          <button
                            type="button"
                            className="email-row-action"
                            data-tooltip="Mark as unread"
                            data-tooltip-align="right"
                            aria-label="Mark as unread"
                            onClick={() => void onMarkUnread(email.id)}
                          >
                            <EmailsIcon size={16} />
                          </button>
                        )}
                    {email.has_attachments && (
                      <button
                        type="button"
                        className="email-row-action"
                        data-tooltip="View attachments"
                        data-tooltip-align="right"
                        aria-label="View attachments"
                        onClick={() => onOpenEmail(email)}
                      >
                        <AttachmentIcon size={16} />
                      </button>
                    )}
                    {/* Last, at the row's end. */}
                    {rowSnooze && (
                      <button
                        type="button"
                        className="email-row-action"
                        data-tooltip="Snooze"
                        data-tooltip-align="right"
                        aria-label="Snooze"
                        aria-haspopup="menu"
                        aria-expanded={snoozeFor?.id === email.id}
                        disabled={busyIds.has(email.id)}
                        onClick={(event) => {
                          const anchor = event.currentTarget;
                          setSnoozeFor((cur) =>
                            cur?.id === email.id
                              ? null
                              : { id: email.id, anchor }
                          );
                        }}
                      >
                        <SnoozeIcon size={16} />
                      </button>
                    )}
                    {rowUnsnooze && (
                      <button
                        type="button"
                        className="email-row-action"
                        data-tooltip="Unsnooze"
                        data-tooltip-align="right"
                        aria-label="Unsnooze"
                        disabled={busyIds.has(email.id)}
                        onClick={() =>
                          void runRowAction(
                            email.id,
                            rowUnsnooze,
                            "Failed to unsnooze email"
                          )
                        }
                      >
                        <UnsnoozeIcon size={16} />
                      </button>
                    )}
                  </span>
                )}
              </div>
              {/* Single-line, Gmail-mobile-style row: avatar, sender, then
              subject and preview flowing together as one truncating line, with
              the attachment pin and time pinned to the right edge. Sender and
              subject/preview each get their own fixed-then-flexible grid track
              (see `.mobile-email-row` in emails.css) so nothing wraps to a
              second line. */}
              <div className="mobile-email-row">
                <div className="mobile-email-avatar" aria-hidden="true">
                  {conversationSenders(email, ownAddresses, displaySender)
                    .lead.trim()
                    .charAt(0)
                    .toUpperCase()}
                </div>
                <span className={senderClass("mobile-email-sender", email)}>
                  <SenderNames email={email} ownAddresses={ownAddresses} />
                  <ConversationCount email={email} />
                </span>
                <span className="mobile-email-subject-line">
                  {email.is_invite && (
                    <InviteIcon
                      size={12}
                      className="email-invite-mark"
                      aria-label="Meeting invitation"
                      role="img"
                    />
                  )}
                  <span className="mobile-email-subject">
                    {email.subject || "(No Subject)"}
                  </span>
                  {(email.preview || email.body) && (
                    <span className="mobile-email-preview">
                      {" "}
                      – {email.preview || email.body}
                    </span>
                  )}
                </span>
                {email.has_attachments && (
                  <span
                    className="mobile-email-attachment-pin"
                    aria-label="Has attachments"
                  >
                    📎
                  </span>
                )}
                <span className="mobile-email-time">
                  {formatMobileTime(email.created_at)}
                </span>
                {onToggleStar && star(email, "mobile-email-star")}
              </div>
            </div>
          ))}
        </>
      )}

      {snoozeFor && rowSnooze && (
        <SnoozeMenu
          anchor={snoozeFor.anchor}
          onClose={() => setSnoozeFor(null)}
          onPick={(until) => {
            const { id } = snoozeFor;
            setSnoozeFor(null);
            void runRowAction(
              id,
              (rowId) => rowSnooze(rowId, until),
              "Failed to snooze email"
            );
          }}
        />
      )}

      {showPager && !pagerSlot && pager}
      {showPager && pagerSlot && createPortal(pager, pagerSlot)}
    </div>
  );
};

// The number of messages in a conversation row, as Gmail shows it beside the
// sender. Nothing for a single message.
// A conversation row names each person on their own, bold only while they
// have an unread message (as Gmail does), so the sender column drops the
// whole-row weight. A per-email row keeps it.
function senderClass(base: string, email: EmailItem): string {
  return email.participants?.length ? `${base} by-person` : base;
}

function SenderNames({
  email,
  ownAddresses,
}: {
  email: EmailItem;
  ownAddresses: string[];
}) {
  const { names, gap } = conversationSenders(
    email,
    ownAddresses,
    displaySender
  );
  return (
    <>
      {names.map((sender, i) => (
        <Fragment key={i}>
          {i > 0 && (gap && i === 1 ? " … " : ", ")}
          <span
            className={
              sender.unread
                ? "email-sender-name is-unread"
                : "email-sender-name"
            }
          >
            {sender.name}
          </span>
        </Fragment>
      ))}
    </>
  );
}

function ConversationCount({ email }: { email: EmailItem }) {
  if (!isConversation(email)) return null;
  return (
    <span
      className="email-conversation-count"
      aria-label={`${email.message_count} messages`}
    >
      {email.message_count}
    </span>
  );
}
