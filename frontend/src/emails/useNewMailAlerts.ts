import { useEffect, useRef } from "react";
import { getEmails } from "../api/email";
import { raiseArrivalAlert } from "../components/messageAlerts";
import { EMAILS_SYNCED_EVENT } from "./useEmailLiveRefresh";
import type { EmailItem } from "./types";

const POLL_MS = 60_000;
// More than this many at once is a mailbox being connected or re-synced, not
// mail arriving.
const MAX_ARRIVALS = 10;

type InboxRow = Pick<EmailItem, "id" | "sender" | "subject" | "is_read">;

// "Ada Lovelace <ada@example.com>" → "Ada Lovelace".
const senderName = (sender: string | null | undefined) => {
  const raw = (sender ?? "").trim();
  const name = raw
    .replace(/<[^>]*>/, "")
    .replace(/^"|"$/g, "")
    .trim();
  return name || raw || "New email";
};

/**
 * Alerts (chime, and an OS notification when the app isn't in view) when mail
 * arrives in the inbox, on whichever page the user is.
 *
 * The first load only records what is already there. After that, new mail is
 * the unread rows at the top of the inbox that weren't there before: arriving
 * mail sorts first, while older mail pulled in by a history backfill lands
 * below rows already seen and is skipped.
 *
 * It rechecks when the server announces a sync (`EMAILS_SYNCED_EVENT`), once a
 * minute for mailboxes without push, and when the tab comes back into view.
 */
export function useNewMailAlerts(
  userId: number | undefined,
  openMail: () => void
) {
  const openMailRef = useRef(openMail);
  useEffect(() => {
    openMailRef.current = openMail;
  }, [openMail]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let seen: Set<number> | null = null;
    let checking = false;
    let again = false;

    const check = async () => {
      // One request at a time; a signal that lands meanwhile runs one more.
      if (checking) {
        again = true;
        return;
      }
      checking = true;
      try {
        const { emails } = await getEmails<InboxRow>({ folder: "inbox" });
        if (cancelled) return;
        if (seen === null) {
          seen = new Set(emails.map((e) => e.id));
          return;
        }
        const known = seen;
        const firstKnown = emails.findIndex((e) => known.has(e.id));
        const top = firstKnown === -1 ? emails : emails.slice(0, firstKnown);
        for (const e of emails) known.add(e.id);

        const arrived = top.filter((e) => e.is_read !== true);
        if (arrived.length === 0 || arrived.length > MAX_ARRIVALS) return;
        const [first] = arrived;
        raiseArrivalAlert("emails", {
          title:
            arrived.length === 1
              ? senderName(first.sender)
              : `${arrived.length} new emails`,
          body:
            arrived.length === 1
              ? first.subject?.trim() || "(no subject)"
              : arrived.map((e) => senderName(e.sender)).join(", "),
          tag: `mail:${first.id}`,
          onClick: () => openMailRef.current(),
        });
      } catch {
        // Transient: the next signal or poll retries.
      } finally {
        checking = false;
        if (again && !cancelled) {
          again = false;
          void check();
        }
      }
    };
    const onSignal = () => void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") onSignal();
    };

    onSignal();
    const interval = window.setInterval(onSignal, POLL_MS);
    window.addEventListener(EMAILS_SYNCED_EVENT, onSignal);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener(EMAILS_SYNCED_EVENT, onSignal);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId]);
}
