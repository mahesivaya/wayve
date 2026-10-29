import { useState, useEffect, useRef, useCallback } from "react";
import {
  getAccounts,
  getEmails,
  getEmail,
  getEmailAttachments,
  getEmailBody,
  getAllEmailAttachments,
  getEmailThread,
  trashEmails as trashEmailsRequest,
  restoreEmails as restoreEmailsRequest,
  type BulkMoveResult,
  starEmail as starEmailRequest,
  snoozeEmail as snoozeEmailRequest,
  unsnoozeEmail as unsnoozeEmailRequest,
  unstarEmail as unstarEmailRequest,
  markEmailRead,
  markEmailUnread,
  markEmailSenderNoise,
} from "../api/email";
import { logger } from "../utils/logger";
import { decryptWayveBodyIfNeeded, emailBodyErrorMessage } from "./bodyUtils";
import { listFolder } from "./searchScope";
import { EmailAccount, EmailFolder, EmailItem, EmailAttachment } from "./types";
import {
  conversationKey,
  conversationMessageIds,
  isConversation,
  isStarred,
} from "./conversation";

// What a delete moved to Trash: the list rows it took out, and every message
// they cover. Undo restores the messages and puts the rows back.
export interface TrashedBatch {
  rows: EmailItem[];
  ids: number[];
}

// A bulk move that couldn't be sent at all fails every id, with its message.
const allFailed = (ids: number[], err: unknown): BulkMoveResult => ({
  done: [],
  failed: ids.map((id) => ({
    id,
    error: err instanceof Error ? err.message : "Request failed",
  })),
});

// The list's order, as the server sorts it (repo::ListOrder): by `sort_at`,
// newest first, except Snoozed, which lists soonest-back first.
const sortTime = (email: EmailItem) =>
  new Date(email.sort_at ?? email.created_at).getTime();
const listOrder =
  (folder: EmailFolder) =>
  (a: EmailItem, b: EmailItem): number =>
    folder === "snoozed"
      ? sortTime(a) - sortTime(b)
      : sortTime(b) - sortTime(a);

// Folders that hide snoozed mail (repo::folder_snooze); elsewhere a snoozed
// row stays listed.
const HIDES_SNOOZED: ReadonlyArray<EmailFolder> = [
  "inbox",
  "signal",
  "noise",
  "github",
];

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
  // The open conversation's messages, oldest first (list rows, no bodies).
  // Kept apart from `selectedEmail`, which openEmail replaces several times
  // while the newest message's body loads.
  const [conversation, setConversation] = useState<{
    rowId: number;
    messages: EmailItem[];
  } | null>(null);
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
  // The row whose conversation is wanted now. A slower response for a row
  // opened earlier must not take its place.
  const conversationFor = useRef<number | null>(null);

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

  // Tracks which (account, folder, query) the currently-loaded list belongs
  // to, so the effect below can tell a genuine list switch (replace) apart
  // from a `refreshTick` bump on the same view (merge) — see there for why
  // that distinction matters.
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = `${activeAccount ?? "all"}|${activeFolder}|${normalizedSearchQuery}`;
    const isFreshLoad = loadedKeyRef.current !== key;
    loadedKeyRef.current = key;

    const fetchInitialEmails = async () => {
      // Signal (important) and Noise (social + promotions) are resolved
      // server-side in email/repo.rs, so the raw folder is sent as-is.
      const { emails: data, hasMore: hasMorePage } = await getEmails<EmailItem>(
        {
          folder: listFolder(activeFolder, normalizedSearchQuery),
          accountId: activeAccount,
          query: normalizedSearchQuery,
          threads: true,
        }
      );

      if (isFreshLoad) {
        setEmails(data);
        // The backend's `hasMore` reflects DB state only; it doesn't know the
        // provider may still hold older messages we haven't synced. Assume
        // more might exist whenever the list is non-empty, so the user can
        // always trigger `sync_older_page`. loadMore flips this off on an
        // empty page.
        setHasMore(hasMorePage || data.length > 0);
        // Preserve the selection across a list refresh: Emails.tsx polls
        // `refreshTick` every 2s after a mailbox is connected, and each tick
        // would otherwise clobber the open email. Clear it only when the
        // email genuinely left the list (account switch, folder change,
        // delete).
        setSelectedEmail((cur) =>
          cur &&
          data.some(
            (email) =>
              email.id === cur.id ||
              conversationKey(email) === conversationKey(cur)
          )
            ? cur
            : null
        );
        return;
      }

      // `refreshTick` re-fetches only the first page (60s idle poll, or every
      // 2s for ~24s right after connecting a mailbox). Wholesale-replacing
      // `emails` with just that page used to truncate away every row the
      // user had scrolled in via `loadMore`, and hand the list a fresh array
      // of object references even when nothing changed — both read as the
      // whole list silently reloading out from under an idle user. Merge
      // instead: patch fields on rows the fresh page still has (read state,
      // subject edits, etc.), prepend anything genuinely new, and leave
      // already-loaded older pages and `hasMore` untouched. A row deleted on
      // another device lingers until the next real folder/account/search
      // switch — an acceptable staleness cost against a full list reset.
      //
      // Rows are matched by conversation, not id: a conversation's row is its
      // newest message, so a new reply changes the id. Such a conversation
      // moves to the top with the fresh row instead of appearing twice.
      //
      // A row's key can also change under it: an email listed on its own
      // (`e5`) is grouped by the backfill (`t9`), or two conversations merge.
      // So a loaded row also matches the fresh row that now contains it. It is
      // updated in place when it is still that conversation's newest message,
      // and dropped otherwise (the fresh row then goes to the top), so no email
      // is ever listed twice.
      setEmails((prev) => {
        const byKey = new Map(
          data.map((email) => [conversationKey(email), email])
        );
        const byMember = new Map<number, EmailItem>();
        for (const email of data) {
          for (const id of conversationMessageIds(email))
            byMember.set(id, email);
        }
        const placed = new Set<string>();
        const merged = prev.flatMap((email) => {
          const next =
            byKey.get(conversationKey(email)) ?? byMember.get(email.id);
          if (!next) return [email];
          const key = conversationKey(next);
          if (next.id !== email.id || placed.has(key)) return [];
          placed.add(key);
          return [next];
        });
        const newAtTop = data.filter(
          (email) => !placed.has(conversationKey(email))
        );
        return newAtTop.length > 0 ? [...newAtTop, ...merged] : merged;
      });
    };
    void fetchInitialEmails();
  }, [activeAccount, activeFolder, refreshTick, normalizedSearchQuery]);

  const loadMore = async () => {
    if (!hasMore || emails.length === 0 || loadingMore) return;
    setLoadingMore(true);
    try {
      const last = emails[emails.length - 1];
      // Milliseconds, not seconds: flooring the cursor to a whole second skips
      // every email sharing that second on the next page, which makes load-more
      // return empty and the button vanish.
      // The server pages on `sort_at`, so a returned snooze isn't skipped.
      const before = sortTime(last);
      const { emails: data } = await getEmails<EmailItem>({
        folder: listFolder(activeFolder, normalizedSearchQuery),
        accountId: activeAccount,
        query: normalizedSearchQuery,
        before,
        beforeId: last.id,
        threads: true,
      });
      // De-dup on append. Keyset pagination on `(created_at, id)` is usually
      // strict, but a background sync writing a row between the initial fetch
      // and this loadMore can still produce an id overlap, and React keys must
      // be unique.
      setEmails((prev) => {
        const seen = new Set(prev.map(conversationKey));
        const shownIds = new Set(prev.map((email) => email.id));
        const fresh = data.filter(
          (email) =>
            !seen.has(conversationKey(email)) && !shownIds.has(email.id)
        );
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

  // The rest of an opened conversation: its messages (oldest first) for the
  // reading pane, and every other unread one marked read. Best-effort: on
  // failure the newest message still shows on its own.
  const loadConversation = async (row: EmailItem) => {
    try {
      const messages = await getEmailThread<EmailItem>(row.id);
      if (conversationFor.current !== row.id) return;
      // The conversation can hold a message newer than the opened row: one
      // that arrived after the list last refreshed, or that opening it just
      // fetched from Gmail. As in Gmail, the newest is the message shown in
      // full at the bottom, below the earlier ones in time order, and the one
      // Reply answers, so the reading pane (and the row) switch to it.
      // Messages come oldest first.
      const newest = messages[messages.length - 1];
      const shown = newest && newest.id !== row.id ? newest : row;
      const unread = messages
        .filter((m) => m.is_read === false && m.id !== row.id)
        .map((m) => m.id);
      for (const id of unread) {
        void markEmailRead(id).catch((err) => {
          logger.warn("Failed to persist read state", { emailId: id, err });
        });
      }
      if (shown.id === row.id) {
        setConversation({ rowId: row.id, messages });
        return;
      }

      conversationFor.current = shown.id;
      const opened = { ...shown, is_read: true };
      setEmails((prev) =>
        prev.map((item) =>
          item.id === row.id
            ? {
                ...item,
                ...opened,
                message_count: messages.length,
                message_ids: messages.map((m) => m.id).reverse(),
                unread_count: 0,
                unread_ids: [],
              }
            : item
        )
      );
      setConversation({ rowId: shown.id, messages });
      setSelectedEmail({ ...row, ...opened, _bodyLoading: true });
      try {
        const full = await fetchMessage(shown);
        if (conversationFor.current !== shown.id) return;
        setSelectedEmail({ ...row, ...full, is_read: true });
      } catch (err) {
        if (conversationFor.current !== shown.id) return;
        setSelectedEmail({
          ...row,
          ...opened,
          body: "",
          _bodyError: emailBodyErrorMessage(err),
        });
      }
    } catch (err) {
      logger.warn("Failed to load conversation", { emailId: row.id, err });
    }
  };

  // The decrypted body that /emails/{id} left empty. A mailbox body sealed to
  // this user's key normally decrypts here; one sealed to a key this browser
  // lacks (set up on another device) falls back to a live provider fetch,
  // which the server re-seals to the current key without storing it readable.
  const loadBody = async (id: number): Promise<string> => {
    const { body } = await getEmailBody(id);
    try {
      return await decryptWayveBodyIfNeeded(body || "", user_id);
    } catch (err) {
      logger.warn("Sealed body did not decrypt; refetching live", {
        emailId: id,
        err,
      });
      const live = await getEmailBody(id, { live: true });
      return decryptWayveBodyIfNeeded(live.body || "", user_id);
    }
  };

  // One message with its decrypted body and attachments, for expanding an
  // earlier message of a conversation. Same steps and cache as openEmail.
  const fetchMessage = async (email: EmailItem): Promise<EmailItem> => {
    const cached = emailCache.current[email.id];
    if (cached?.body !== undefined && cached.body !== null) return cached;
    const data = await getEmail<EmailItem>(email.id);
    const base = { ...email, ...data };
    const body = data.body
      ? await decryptWayveBodyIfNeeded(data.body, user_id)
      : await loadBody(email.id);
    let attachments = await getEmailAttachments(email.id);
    if (data.body && !data.attachments_checked) {
      await getEmailBody(email.id);
      attachments = await getEmailAttachments(email.id);
    }
    const full = {
      ...base,
      body,
      attachments,
    };
    emailCache.current[email.id] = full;
    return full;
  };

  const openEmail = async (email: EmailItem) => {
    setViewMode("email");
    const openedEmail = { ...email, is_read: true, unread_count: 0 };
    const wasUnread = email.is_read === false;
    // A conversation row counts every unread message in it, not just the
    // newest; opening it reads them all.
    const unreadDrop = email.unread_count ?? (wasUnread ? 1 : 0);
    setEmails((prev) =>
      prev.map((item) =>
        item.id === email.id
          ? { ...item, is_read: true, unread_count: 0 }
          : item
      )
    );

    // Decrement the sidebar unread badge optimistically. The authoritative
    // count arrives with the next /api/accounts fetch.
    if (unreadDrop > 0 && email.account_id != null) {
      setAccounts((prev) =>
        prev.map((acc) =>
          acc.id === email.account_id
            ? {
                ...acc,
                unread_count: Math.max(0, (acc.unread_count ?? 0) - unreadDrop),
              }
            : acc
        )
      );
    }

    setConversation(null);
    conversationFor.current = email.id;
    if (isConversation(email)) void loadConversation(email);

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

    // Another email opened since, or the conversation switched the pane to a
    // newer message (loadConversation): this one must not take it back.
    const stillShown = () => conversationFor.current === email.id;
    try {
      const data = await getEmail<EmailItem>(email.id);
      if (!stillShown()) return;
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
        if (stillShown()) setSelectedEmail(full);
      } else {
        setSelectedEmail({ ...emailWithListFields, _bodyLoading: true });
        const decryptedBody = await loadBody(email.id);
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
      if (!stillShown()) return;
      setSelectedEmail({
        ...openedEmail,
        body: "",
        _bodyError: emailBodyErrorMessage(err),
      });
    }
  };

  // Deleting moves the whole conversation to Trash, as in Gmail. A plain row
  // covers just itself. Waits for the server, so a failure leaves the row and
  // reaches the caller.
  const deleteEmail = async (emailId: number): Promise<TrashedBatch> => {
    const row = emails.find(
      (email) => email.id === emailId || email.message_ids?.includes(emailId)
    );
    const ids = row ? conversationMessageIds(row) : [emailId];
    // One request for the whole conversation. If any message can't move, the
    // row stays and the reason reaches the caller; the ones that did move are
    // in Trash, and the next refresh shows that.
    const { failed } = await trashEmailsRequest(ids);
    if (failed.length > 0) throw new Error(failed[0].error);
    for (const id of ids) delete emailCache.current[id];
    const gone = row ? conversationKey(row) : null;
    const isGone = (email: EmailItem) =>
      email.id === emailId ||
      (gone !== null && conversationKey(email) === gone);
    const rows = emails.filter(isGone);
    setEmails((prev) => prev.filter((email) => !isGone(email)));
    setSelectedEmail((cur) => (cur && ids.includes(cur.id) ? null : cur));
    setConversation(null);
    return { rows, ids };
  };

  // Undo a delete: take its messages back out of Trash and put their rows back
  // in the list. A row any of whose messages failed to restore stays out (the
  // next refresh shows where it really is). Resolves to the number of failures.
  const undoTrash = async (batch: TrashedBatch): Promise<number> => {
    const result = await restoreEmailsRequest(batch.ids).catch((err) =>
      allFailed(batch.ids, err)
    );
    const failed = new Set(result.failed.map((f) => f.id));
    if (failed.size > 0) {
      logger.warn("undoTrash: some restores failed", {
        failed: failed.size,
        total: batch.ids.length,
      });
    }
    // Restored mail leaves Trash, so there is nothing to put back there.
    if (activeFolder !== "trash") {
      const back = batch.rows.filter((row) =>
        conversationMessageIds(row).every((id) => !failed.has(id))
      );
      setEmails((prev) => {
        const listed = new Set(prev.map(conversationKey));
        const missing = back.filter((row) => !listed.has(conversationKey(row)));
        return missing.length > 0
          ? [...prev, ...missing].sort(listOrder(activeFolder))
          : prev;
      });
    }
    return failed.size;
  };

  // Restore one row from the Trash folder (listed per email there), which
  // takes it out of this list. A failure leaves the row and reaches the caller.
  const restoreEmail = async (emailId: number) => {
    const { failed } = await restoreEmailsRequest([emailId]);
    if (failed.length > 0) throw new Error(failed[0].error);
    delete emailCache.current[emailId];
    setEmails((prev) => prev.filter((email) => email.id !== emailId));
    setSelectedEmail((cur) => (cur?.id === emailId ? null : cur));
  };

  // Mark the email's sender as noise. The backend routes all of that address's
  // mail into Noise and out of the inbox; here we optimistically drop every
  // loaded row from that sender so the current list updates immediately.
  const markSenderNoise = async (emailId: number) => {
    const { sender_email } = await markEmailSenderNoise(emailId);
    const needle = sender_email.toLowerCase();
    const fromSender = (email: EmailItem) =>
      (email.sender ?? "").toLowerCase().includes(needle);
    setEmails((prev) => prev.filter((email) => !fromSender(email)));
    setSelectedEmail((cur) => (cur && fromSender(cur) ? null : cur));
  };

  // Failed POSTs log but don't roll back, so a flaky network mid-batch doesn't
  // make rows pop back to unread; the next provider sync reconciles.
  // `ids` are list rows; a conversation row covers every message in it.
  const bulkMarkRead = async (rowIds: number[]) => {
    if (rowIds.length === 0) return;
    const idSet = new Set(rowIds);
    const rows = emails.filter((email) => idSet.has(email.id));
    // A conversation sends only its unread messages: each read also goes to
    // the provider, so posting every message would be wasted calls.
    const listed = new Set(rows.map((email) => email.id));
    const ids = Array.from(
      new Set([
        ...rowIds.filter((id) => !listed.has(id)),
        ...rows.flatMap((row) =>
          isConversation(row)
            ? (row.unread_ids ?? conversationMessageIds(row))
            : [row.id]
        ),
      ])
    );
    const unreadByAccount = new Map<number, number>();
    setEmails((prev) =>
      prev.map((email) => {
        if (!idSet.has(email.id)) return email;
        const drop = email.unread_count ?? (email.is_read === false ? 1 : 0);
        if (drop > 0 && email.account_id != null) {
          unreadByAccount.set(
            email.account_id,
            (unreadByAccount.get(email.account_id) ?? 0) + drop
          );
        }
        return { ...email, is_read: true, unread_count: 0 };
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
        return {
          ...email,
          is_read: false,
          unread_count: Math.max(1, email.unread_count ?? 0),
        };
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

  // Star or unstar a list row, as in Gmail: starring stars the row's own
  // (newest) message; unstarring clears every starred message in it. The star
  // flips at once and flips back if the server refuses, and the error reaches
  // the caller.
  const toggleStar = async (rowId: number) => {
    const row = emails.find((email) => email.id === rowId);
    if (!row) return;
    const starred = isStarred(row);
    const ids = starred ? (row.starred_ids ?? [row.id]) : [row.id];
    const patch = (email: EmailItem, next: Partial<EmailItem>) =>
      email.id === rowId ? { ...email, ...next } : email;
    const flipped = starred
      ? { is_starred: false, starred_ids: [] }
      : { is_starred: true, starred_ids: [row.id, ...(row.starred_ids ?? [])] };
    const before = { is_starred: row.is_starred, starred_ids: row.starred_ids };
    setEmails((prev) => prev.map((email) => patch(email, flipped)));
    try {
      await Promise.all(
        ids.map((id) =>
          starred ? unstarEmailRequest(id) : starEmailRequest(id)
        )
      );
    } catch (err) {
      setEmails((prev) => prev.map((email) => patch(email, before)));
      throw err;
    }
  };

  // Snooze a list row until `until`: every message in its conversation, as in
  // Gmail. The row leaves the inbox views at once and comes back on its own;
  // elsewhere (All mail, Starred, …) it stays, marked snoozed. If the server
  // refuses, the messages already snoozed are unsnoozed again, the row comes
  // back, and the error reaches the caller.
  const snoozeRow = async (
    rowId: number,
    until: Date
  ): Promise<TrashedBatch> => {
    const row = emails.find((email) => email.id === rowId);
    if (!row) return { rows: [], ids: [] };
    const ids = conversationMessageIds(row);
    const hides = HIDES_SNOOZED.includes(activeFolder);
    const untilIso = until.toISOString();
    if (hides) {
      setEmails((prev) => prev.filter((email) => email.id !== rowId));
      setSelectedEmail((cur) => (cur && ids.includes(cur.id) ? null : cur));
    } else {
      setEmails((prev) =>
        prev.map((email) =>
          email.id === rowId ? { ...email, snoozed_until: untilIso } : email
        )
      );
    }
    const results = await Promise.allSettled(
      ids.map((id) => snoozeEmailRequest(id, until))
    );
    const failure = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    if (failure) {
      await Promise.allSettled(
        ids
          .filter((_, i) => results[i].status === "fulfilled")
          .map((id) => unsnoozeEmailRequest(id))
      );
      setEmails((prev) =>
        hides
          ? [...prev.filter((email) => email.id !== rowId), row].sort(
              listOrder(activeFolder)
            )
          : prev.map((email) => (email.id === rowId ? row : email))
      );
      throw failure.reason;
    }
    return { rows: [row], ids };
  };

  // Undo a snooze: end it and put the row back where it was. Resolves to the
  // number of messages that couldn't be unsnoozed (their row stays out).
  const undoSnooze = async (batch: TrashedBatch): Promise<number> => {
    const results = await Promise.allSettled(
      batch.ids.map((id) => unsnoozeEmailRequest(id))
    );
    const failed = new Set(
      batch.ids.filter((_, i) => results[i].status === "rejected")
    );
    const back = batch.rows
      .filter((row) =>
        conversationMessageIds(row).every((id) => !failed.has(id))
      )
      .map((row) => ({ ...row, snoozed_until: null }));
    if (activeFolder === "snoozed") {
      setEmails((prev) =>
        prev.filter((email) => !back.some((row) => row.id === email.id))
      );
    } else {
      setEmails((prev) => {
        const kept = prev.filter(
          (email) => !back.some((row) => row.id === email.id)
        );
        return [...kept, ...back].sort(listOrder(activeFolder));
      });
    }
    return failed.size;
  };

  // End a row's snooze from the Snoozed folder: back to the inbox now, at its
  // own place. A failure keeps the row and reaches the caller.
  const unsnoozeRow = async (rowId: number) => {
    const row = emails.find((email) => email.id === rowId);
    if (!row) return;
    await Promise.all(
      conversationMessageIds(row).map((id) => unsnoozeEmailRequest(id))
    );
    setEmails((prev) =>
      activeFolder === "snoozed"
        ? prev.filter((email) => email.id !== rowId)
        : prev.map((email) =>
            email.id === rowId ? { ...email, snoozed_until: null } : email
          )
    );
  };

  // Optimistic removal, then parallel deletes. A failed delete leaves the row
  // gone from the UI until the next refresh pulls it back, which is acceptable
  // here because the user can simply re-delete.
  // `ids` are list rows; deleting a conversation row moves every message in it
  // to Trash, as in Gmail.
  const bulkDelete = async (rowIds: number[]): Promise<TrashedBatch> => {
    if (rowIds.length === 0) return { rows: [], ids: [] };
    const rowSet = new Set(rowIds);
    const rows = emails.filter((email) => rowSet.has(email.id));
    const ids = Array.from(
      new Set([...rowIds, ...rows.flatMap(conversationMessageIds)])
    );
    const idSet = new Set(ids);
    setEmails((prev) => prev.filter((email) => !rowSet.has(email.id)));
    setSelectedEmail((cur) => (cur && idSet.has(cur.id) ? null : cur));
    for (const id of ids) delete emailCache.current[id];
    const { failed } = await trashEmailsRequest(ids).catch((err) =>
      allFailed(ids, err)
    );
    if (failed.length > 0) {
      logger.warn("bulkDelete: some emails failed", {
        failed: failed.length,
        total: ids.length,
      });
    }
    return { rows, ids };
  };

  // Restore the selected rows from Trash in one request: they leave the Trash
  // list at once, and any that fail come back with the first reason. Trash
  // lists one row per email, so a row is one message.
  const bulkRestore = async (
    rowIds: number[]
  ): Promise<{ restored: number; failed: number; error?: string }> => {
    if (rowIds.length === 0) return { restored: 0, failed: 0 };
    const rowSet = new Set(rowIds);
    const rows = emails.filter((email) => rowSet.has(email.id));
    setEmails((prev) => prev.filter((email) => !rowSet.has(email.id)));
    setSelectedEmail((cur) => (cur && rowSet.has(cur.id) ? null : cur));
    const result = await restoreEmailsRequest(rowIds).catch((err) =>
      allFailed(rowIds, err)
    );
    for (const id of result.done) delete emailCache.current[id];
    const failed = new Set(result.failed.map((f) => f.id));
    if (failed.size > 0) {
      setEmails((prev) =>
        [...prev, ...rows.filter((row) => failed.has(row.id))].sort(
          listOrder(activeFolder)
        )
      );
    }
    return {
      restored: result.done.length,
      failed: failed.size,
      error: result.failed[0]?.error,
    };
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
    conversation,
    fetchMessage,
    deleteEmail,
    toggleStar,
    snoozeRow,
    undoSnooze,
    unsnoozeRow,
    undoTrash,
    restoreEmail,
    markSenderNoise,
    bulkMarkRead,
    bulkDelete,
    bulkRestore,
    markRead,
    markUnread,
  };
}
