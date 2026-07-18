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
  markEmailUnread,
} from "../api/email";
import { logger } from "../utils/logger";
import { decryptWayveBodyIfNeeded, emailBodyErrorMessage } from "./bodyUtils";
import { EmailAccount, EmailFolder, EmailItem, EmailAttachment } from "./types";

export function useEmailInbox(
  user_id: number | undefined,
  normalizedSearchQuery: string
) {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  // Flips true after the first /api/accounts response, success or failure, so
  // the UI can tell "still loading" apart from "genuinely zero accounts".
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [emails, setEmails] = useState<EmailItem[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<EmailItem | null>(null);
  const [activeAccount, setActiveAccount] = useState<number | null>(null);
  const [activeFolder, setActiveFolder] = useState<EmailFolder>("inbox");
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
      logger.error("Fetch accounts failed", err);
    } finally {
      setAccountsLoaded(true);
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
      // Signal (important) and Noise (social + promotions) are resolved
      // server-side in email/repo.rs, so the raw folder is sent as-is.
      const { emails: data, hasMore: hasMorePage } = await getEmails<EmailItem>(
        {
          folder: activeFolder,
          accountId: activeAccount,
          query: normalizedSearchQuery,
        }
      );
      setEmails(data);
      // The backend's `hasMore` reflects DB state only; it doesn't know the
      // provider may still hold older messages we haven't synced. Assume more
      // might exist whenever the list is non-empty, so the user can always
      // trigger `sync_older_page`. loadMore flips this off on an empty page.
      setHasMore(hasMorePage || data.length > 0);
      // Preserve the selection across a list refresh: Emails.tsx polls
      // `refreshTick` every 2s after a mailbox is connected, and each tick
      // would otherwise clobber the open email. Clear it only when the email
      // genuinely left the list (account switch, folder change, delete).
      setSelectedEmail((cur) =>
        cur && data.some((email) => email.id === cur.id) ? cur : null
      );
    };
    void fetchInitialEmails();
  }, [
    activeAccount,
    activeFolder,
    queryFolder,
    refreshTick,
    normalizedSearchQuery,
  ]);

  const loadMore = async () => {
    if (!hasMore || emails.length === 0 || loadingMore) return;
    setLoadingMore(true);
    try {
      const last = emails[emails.length - 1];
      // Milliseconds, not seconds: flooring the cursor to a whole second skips
      // every email sharing that second on the next page, which makes load-more
      // return empty and the button vanish.
      const before = new Date(last.created_at).getTime();
      const { emails: data } = await getEmails<EmailItem>({
        folder: queryFolder,
        accountId: activeAccount,
        query: normalizedSearchQuery,
        before,
        beforeId: last.id,
      });
      // De-dup on append. Keyset pagination on `(created_at, id)` is usually
      // strict, but a background sync writing a row between the initial fetch
      // and this loadMore can still produce an id overlap, and React keys must
      // be unique.
      setEmails((prev) => {
        const seen = new Set(prev.map((email) => email.id));
        const fresh = data.filter((email) => !seen.has(email.id));
        return fresh.length === data.length
          ? [...prev, ...data]
          : [...prev, ...fresh];
      });
      // Same reason as above: the backend only knows whether this SQL page hit
      // its LIMIT, not whether the provider holds older mail. Only an empty
      // response proves we reached the end.
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
      setFilesError(
        err instanceof Error ? err.message : "Failed to load files"
      );
    } finally {
      setFilesLoading(false);
    }
  };

  // While the Files view is open and the body worker still has emails to
  // process, poll so new attachments stream in. Stops once every email has
  // `attachments_checked === true`.
  const inboxStillScanning =
    viewMode === "files" &&
    accounts.length > 0 &&
    (emails.length === 0 ||
      emails.some((email) => email.attachments_checked === false));

  useEffect(() => {
    if (!inboxStillScanning) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const data = await getAllEmailAttachments();
        if (!cancelled) setFiles(data);
      } catch {
        // Keep the old list rather than blanking it; the next tick retries.
      }
    }, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [inboxStillScanning]);

  const openEmail = async (email: EmailItem) => {
    setViewMode("email");
    const openedEmail = { ...email, is_read: true };
    const wasUnread = email.is_read === false;
    setEmails((prev) =>
      prev.map((item) =>
        item.id === email.id ? { ...item, is_read: true } : item
      )
    );

    // Decrement the sidebar unread badge optimistically. The authoritative
    // count arrives with the next /api/accounts fetch.
    if (wasUnread && email.account_id != null) {
      setAccounts((prev) =>
        prev.map((acc) =>
          acc.id === email.account_id
            ? { ...acc, unread_count: Math.max(0, (acc.unread_count ?? 0) - 1) }
            : acc
        )
      );
    }

    // Fire-and-forget: a failed POST logs but does not roll back the optimistic
    // UI above, and the next provider sync reconciles.
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
        const decryptedBody = await decryptWayveBodyIfNeeded(
          emailWithListFields.body || "",
          user_id
        );
        let attachments = await getEmailAttachments(email.id);
        if (!data.attachments_checked) {
          await getEmailBody(email.id);
          attachments = await getEmailAttachments(email.id);
        }
        const full = {
          ...emailWithListFields,
          body: decryptedBody,
          attachments,
        };
        emailCache.current[email.id] = full;
        setSelectedEmail(full);
      } else {
        setSelectedEmail({ ...emailWithListFields, _bodyLoading: true });
        const { body } = await getEmailBody(email.id);
        const decryptedBody = await decryptWayveBodyIfNeeded(
          body || "",
          user_id
        );
        const attachments = await getEmailAttachments(email.id);
        const merged = {
          ...emailWithListFields,
          body: decryptedBody,
          attachments,
          _bodyLoading: false,
        };
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

  // Failed POSTs log but don't roll back, so a flaky network mid-batch doesn't
  // make rows pop back to unread; the next provider sync reconciles.
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
            (unreadByAccount.get(email.account_id) ?? 0) + 1
          );
        }
        return { ...email, is_read: true };
      })
    );
    setAccounts((prev) =>
      prev.map((acc) => {
        const drop = unreadByAccount.get(acc.id) ?? 0;
        if (drop === 0) return acc;
        return {
          ...acc,
          unread_count: Math.max(0, (acc.unread_count ?? 0) - drop),
        };
      })
    );
    // Patch the cache too, so a subsequent open() doesn't repaint as unread.
    for (const id of ids) {
      const cached = emailCache.current[id];
      if (cached) emailCache.current[id] = { ...cached, is_read: true };
    }
    await Promise.allSettled(ids.map((id) => markEmailRead(id))).then(
      (results) => {
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
          logger.warn("bulkMarkRead: some calls failed", {
            failed,
            total: ids.length,
          });
        }
      }
    );
  };

  // Single-row read (hover action). Reuses the optimistic bulk path so cache and
  // account badges stay in sync.
  const markRead = (id: number) => bulkMarkRead([id]);

  // Single-row unread — the inverse: flip the row, bump the account badge, patch
  // the cache, then POST. A failed POST reconciles on the next sync.
  const markUnread = async (id: number) => {
    let accountId: number | null = null;
    setEmails((prev) =>
      prev.map((email) => {
        if (email.id !== id) return email;
        if (email.is_read !== false) accountId = email.account_id ?? null;
        return { ...email, is_read: false };
      })
    );
    if (accountId != null) {
      setAccounts((prev) =>
        prev.map((acc) =>
          acc.id === accountId
            ? { ...acc, unread_count: (acc.unread_count ?? 0) + 1 }
            : acc
        )
      );
    }
    const cached = emailCache.current[id];
    if (cached) emailCache.current[id] = { ...cached, is_read: false };
    try {
      await markEmailUnread(id);
    } catch (err) {
      logger.warn("markUnread failed", { id, err });
    }
  };

  // Optimistic removal, then parallel deletes. A failed delete leaves the row
  // gone from the UI until the next refresh pulls it back, which is acceptable
  // here because the user can simply re-delete.
  const bulkDelete = async (ids: number[]) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    setEmails((prev) => prev.filter((email) => !idSet.has(email.id)));
    setSelectedEmail((cur) => (cur && idSet.has(cur.id) ? null : cur));
    for (const id of ids) delete emailCache.current[id];
    await Promise.allSettled(ids.map((id) => deleteEmailRequest(id))).then(
      (results) => {
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
          logger.warn("bulkDelete: some calls failed", {
            failed,
            total: ids.length,
          });
        }
      }
    );
  };

  return {
    accounts,
    accountsLoaded,
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
    markRead,
    markUnread,
  };
}
