import { useState, useEffect, useRef, useCallback } from "react";
import {
  getAccounts,
  getEmails,
  getEmail,
  getEmailAttachments,
  getEmailBody,
  getAllEmailAttachments,
  deleteEmail as deleteEmailRequest,
  markEmailRead,
} from "../api/email";
import { logger } from "../utils/logger";
import { decryptWayveBodyIfNeeded, emailBodyErrorMessage } from "./bodyUtils";
import { EmailAccount, EmailItem, EmailAttachment } from "./types";

export function useEmailInbox(user_id: number | undefined, normalizedSearchQuery: string) {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [emails, setEmails] = useState<EmailItem[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<EmailItem | null>(null);
  const [activeAccount, setActiveAccount] = useState<number | null>(null);
  const [activeFolder, setActiveFolder] = useState<"inbox" | "sent">("inbox");
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [viewMode, setViewMode] = useState<"email" | "files">("email");
  const [files, setFiles] = useState<EmailAttachment[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  const emailCache = useRef<Record<number, EmailItem>>({});

  const fetchAccounts = useCallback(async () => {
    try {
      const data = await getAccounts<EmailAccount>();
      setAccounts(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Fetch accounts failed", err);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchAccounts();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [fetchAccounts]);

  useEffect(() => {
    emailCache.current = {};
  }, [activeAccount, user_id]);

  useEffect(() => {
    const fetchInitialEmails = async () => {
      const { emails: data, hasMore: hasMorePage } = await getEmails<EmailItem>({
        folder: activeFolder,
        accountId: activeAccount,
        query: normalizedSearchQuery,
      });
      setEmails(data);
      // The backend's `hasMore` reflects the DB state only — it doesn't know
      // that the provider (Gmail/Outlook) may have older messages we haven't
      // synced yet. Default to "more might exist" whenever the list is
      // non-empty, so the user can always trigger `sync_older_page` via the
      // "Show more" button. Once a load-more returns zero new rows, the click
      // handler flips this off and the button hides.
      setHasMore(hasMorePage || data.length > 0);
      // Preserve the user's selection across a list refresh. The post-import
      // poll in [Emails.tsx](./Emails.tsx) bumps `refreshTick` every 2 s for
      // ~24 s after a new mailbox is connected — without this, every tick
      // would clobber the selected email back to "Select an email". We only
      // clear the selection when the email genuinely left the list (account
      // switch, folder change, server-side delete).
      setSelectedEmail((cur) =>
        cur && data.some((email) => email.id === cur.id) ? cur : null,
      );
    };
    void fetchInitialEmails();
  }, [activeAccount, activeFolder, refreshTick, normalizedSearchQuery]);

  const loadMore = async () => {
    if (!hasMore || emails.length === 0 || loadingMore) return;
    setLoadingMore(true);
    try {
      const last = emails[emails.length - 1];
      // Pass cursor as milliseconds so the backend can preserve sub-second
      // ordering. Flooring to whole seconds (the old behavior) would skip
      // any email sharing the cursor's second on the next page, causing
      // load-more to return empty and the button to vanish.
      const before = new Date(last.created_at).getTime();
      const { emails: data } = await getEmails<EmailItem>({
        folder: activeFolder,
        accountId: activeAccount,
        query: normalizedSearchQuery,
        before,
        beforeId: last.id,
      });
      // Defensive de-dup on append. The backend's keyset pagination
       // `(created_at, id) < (before, beforeId)` is usually strict, but a
       // background sync writing a row between the initial fetch and this
       // loadMore — or two emails sharing the same created_at second — can
       // produce an id overlap. React keys must be unique, so drop rows we
       // already have rather than rendering a duplicate.
       setEmails((prev) => {
         const seen = new Set(prev.map((email) => email.id));
         const fresh = data.filter((email) => !seen.has(email.id));
         return fresh.length === data.length ? [...prev, ...data] : [...prev, ...fresh];
       });
      // The backend's `hasMore` reflects only whether *this* SQL page hit the
      // 51-row LIMIT — it doesn't know whether the provider (Gmail/Outlook)
      // still has more older mail past what was pulled in this tick. Treat
      // any non-empty response as "more might exist; let the user click
      // again." Only an empty response means we've reached the end.
      setHasMore(data.length > 0);
    } finally {
      setLoadingMore(false);
    }
  };

  const openFiles = async () => {
    if (viewMode === "files") {
      setViewMode("email");
      return;
    }
    setViewMode("files");
    setFilesLoading(true);
    setFilesError(null);
    try {
      const data = await getAllEmailAttachments();
      setFiles(data);
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setFilesLoading(false);
    }
  };

  const openEmail = async (email: EmailItem) => {
    setViewMode("email");
    const openedEmail = { ...email, is_read: true };
    const wasUnread = email.is_read === false;
    setEmails((prev) =>
      prev.map((item) => (item.id === email.id ? { ...item, is_read: true } : item))
    );

    // Decrement the matching account's unread badge in the sidebar. The
    // server-side count comes back on the next /api/accounts fetch (which the
    // post-import poll already triggers), so this is purely about the
    // immediate flicker — without it, the badge stays stale until refresh.
    if (wasUnread && email.account_id != null) {
      setAccounts((prev) =>
        prev.map((acc) =>
          acc.id === email.account_id
            ? { ...acc, unread_count: Math.max(0, (acc.unread_count ?? 0) - 1) }
            : acc,
        ),
      );
    }

    // Persist the read state so a page refresh doesn't bring the row back as
    // unread. Fire-and-forget — the optimistic UI above is the source of
    // truth for this render; a failed POST gets a log line but no rollback
    // (the next provider sync will reconcile if needed).
    if (wasUnread) {
      void markEmailRead(email.id).catch((err) => {
        logger.warn("Failed to persist read state", { emailId: email.id, err });
      });
    }
    if (emailCache.current[email.id]) {
      const cached = { ...emailCache.current[email.id], is_read: true };
      emailCache.current[email.id] = cached;
      setSelectedEmail(cached);
      return;
    }

    try {
      const data = await getEmail<EmailItem>(email.id);
      const emailWithListFields = { ...openedEmail, ...data, is_read: true };
      if (data.body) {
        const decryptedBody = await decryptWayveBodyIfNeeded(emailWithListFields.body || "", user_id);
        let attachments = await getEmailAttachments(email.id);
        if (!data.attachments_checked) {
          await getEmailBody(email.id);
          attachments = await getEmailAttachments(email.id);
        }
        const full = { ...emailWithListFields, body: decryptedBody, attachments };
        emailCache.current[email.id] = full;
        setSelectedEmail(full);
      } else {
        setSelectedEmail({ ...emailWithListFields, _bodyLoading: true });
        const { body } = await getEmailBody(email.id);
        const decryptedBody = await decryptWayveBodyIfNeeded(body || "", user_id);
        const attachments = await getEmailAttachments(email.id);
        const merged = { ...emailWithListFields, body: decryptedBody, attachments, _bodyLoading: false };
        emailCache.current[email.id] = merged;
        setSelectedEmail((cur) => (cur?.id === email.id ? merged : cur));
      }
    } catch (err) {
      setSelectedEmail({
        ...openedEmail,
        body: "",
        _bodyError: emailBodyErrorMessage(err),
      });
    }
  };

  const deleteEmail = async (emailId: number) => {
    await deleteEmailRequest(emailId);
    delete emailCache.current[emailId];
    setEmails((prev) => prev.filter((email) => email.id !== emailId));
    setSelectedEmail((cur) => (cur?.id === emailId ? null : cur));
  };

  // Apply mark-read to many ids at once. Optimistic UI is the source of
  // truth in this render; failed POSTs log but don't roll back so a flaky
  // network mid-batch doesn't make rows pop back to "unread" — the next
  // provider sync reconciles. Decrements the per-account unread badge by
  // however many were actually unread.
  const bulkMarkRead = async (ids: number[]) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const unreadByAccount = new Map<number, number>();
    setEmails((prev) =>
      prev.map((email) => {
        if (!idSet.has(email.id)) return email;
        if (email.is_read === false && email.account_id != null) {
          unreadByAccount.set(
            email.account_id,
            (unreadByAccount.get(email.account_id) ?? 0) + 1,
          );
        }
        return { ...email, is_read: true };
      }),
    );
    setAccounts((prev) =>
      prev.map((acc) => {
        const drop = unreadByAccount.get(acc.id) ?? 0;
        if (drop === 0) return acc;
        return { ...acc, unread_count: Math.max(0, (acc.unread_count ?? 0) - drop) };
      }),
    );
    // Also patch the cache so a subsequent open() doesn't repaint as unread.
    for (const id of ids) {
      const cached = emailCache.current[id];
      if (cached) emailCache.current[id] = { ...cached, is_read: true };
    }
    await Promise.allSettled(ids.map((id) => markEmailRead(id))).then((results) => {
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        logger.warn("bulkMarkRead: some calls failed", { failed, total: ids.length });
      }
    });
  };

  // Optimistic remove from the list, then fire deletes in parallel. On any
  // failure the row is gone from the UI but the next refresh will pull it
  // back if the backend still has it — acceptable for the bulk action since
  // the user can re-delete.
  const bulkDelete = async (ids: number[]) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    setEmails((prev) => prev.filter((email) => !idSet.has(email.id)));
    setSelectedEmail((cur) => (cur && idSet.has(cur.id) ? null : cur));
    for (const id of ids) delete emailCache.current[id];
    await Promise.allSettled(ids.map((id) => deleteEmailRequest(id))).then((results) => {
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        logger.warn("bulkDelete: some calls failed", { failed, total: ids.length });
      }
    });
  };

  return {
    accounts,
    emails,
    selectedEmail,
    setSelectedEmail,
    activeAccount,
    setActiveAccount,
    activeFolder,
    setActiveFolder,
    hasMore,
    loadingMore,
    viewMode,
    setViewMode,
    files,
    filesLoading,
    filesError,
    fetchAccounts,
    setRefreshTick,
    loadMore,
    openFiles,
    openEmail,
    deleteEmail,
    bulkMarkRead,
    bulkDelete,
  };
}
