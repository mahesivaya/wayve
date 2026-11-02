import { useEffect, useState } from "react";
import { listEmailDrafts, type EmailDraft } from "../api/emailDrafts";
import { logger } from "../utils/logger";

// Fired by useDraftAutosave, so the list stays current without refetching (and
// decrypting) every draft on each save.
export const EMAIL_DRAFT_SAVED_EVENT = "rwayve:email-draft-saved";
export const EMAIL_DRAFT_DELETED_EVENT = "rwayve:email-draft-deleted";

// Those events only reach this tab. A channel never hears its own posts, so this
// tells just the other tabs to refetch, without one refetch per save here.
const CHANNEL_NAME = "rwayve:email-drafts";
const openChannel = () =>
  typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel(CHANNEL_NAME);

export function notifyOtherTabsOfDrafts() {
  const channel = openChannel();
  channel?.postMessage("changed");
  channel?.close();
}

// The user's saved drafts, newest first. `loaded` says the list can be trusted,
// so a composer never decides "no draft here" while it's still on its way.
export function useEmailDrafts(userId: number | undefined) {
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (userId === undefined) return;
    let cancelled = false;
    listEmailDrafts()
      .then((rows) => {
        if (!cancelled) setDrafts(rows);
      })
      .catch((err) => logger.warn("Failed to load email drafts", err))
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    const channel = openChannel();
    if (!channel || userId === undefined) return;
    channel.onmessage = () => {
      listEmailDrafts()
        .then(setDrafts)
        .catch((err) => logger.warn("Failed to refresh email drafts", err));
    };
    return () => channel.close();
  }, [userId]);

  useEffect(() => {
    const onSaved = (e: Event) => {
      const draft = (e as CustomEvent<EmailDraft>).detail;
      setDrafts((prev) => [draft, ...prev.filter((d) => d.id !== draft.id)]);
    };
    const onDeleted = (e: Event) => {
      const id = (e as CustomEvent<number>).detail;
      setDrafts((prev) => prev.filter((d) => d.id !== id));
    };
    window.addEventListener(EMAIL_DRAFT_SAVED_EVENT, onSaved);
    window.addEventListener(EMAIL_DRAFT_DELETED_EVENT, onDeleted);
    return () => {
      window.removeEventListener(EMAIL_DRAFT_SAVED_EVENT, onSaved);
      window.removeEventListener(EMAIL_DRAFT_DELETED_EVENT, onDeleted);
    };
  }, []);

  return { drafts, loaded };
}
