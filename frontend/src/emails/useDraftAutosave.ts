import { useCallback, useEffect, useRef, useState } from "react";
import {
  createEmailDraft,
  deleteEmailDraft,
  updateEmailDraft,
  type DraftContent,
  type DraftKind,
  type EmailDraft,
} from "../api/emailDrafts";
import { logger } from "../utils/logger";
import {
  EMAIL_DRAFT_DELETED_EVENT,
  EMAIL_DRAFT_SAVED_EVENT,
  notifyOtherTabsOfDrafts,
} from "./useEmailDrafts";

const SAVE_DELAY_MS = 1500;

export type DraftStatus = "idle" | "saving" | "saved" | "error";

type Params = {
  kind: DraftKind;
  sourceEmailId: number | null;
  accountId: number | null;
  content: DraftContent;
  // Whether there's anything worth keeping. Clearing it deletes the saved draft.
  hasContent: boolean;
  // False while the composer is closed: what's pending is saved, nothing new is.
  enabled: boolean;
  // The text must stay off the server (Secure send, end-to-end): nothing is saved
  // and any copy already there is deleted.
  sensitive?: boolean;
};

// One saved draft's state. Each source email gets its own, so a save still
// waiting in the queue writes to the draft it was made for.
type Slot = { id: number | null; saved: string | null };

type Snapshot = {
  slot: Slot;
  kind: DraftKind;
  sourceEmailId: number | null;
  accountId: number | null;
  content: DraftContent;
  json: string;
  hasContent: boolean;
};

const announce = (event: string, detail: unknown) => {
  window.dispatchEvent(new CustomEvent(event, { detail }));
  notifyOtherTabsOfDrafts();
};

export const contentOf = (draft: DraftContent): DraftContent => ({
  to: draft.to,
  cc: draft.cc,
  bcc: draft.bcc,
  subject: draft.subject,
  body: draft.body,
});

// Saves `content` shortly after it stops changing, and whatever is still unsaved
// when the composer closes, the page changes or the tab goes away. Requests run
// one at a time, so a create is finished before the save or delete that needs its
// id, and an older save can't land on top of a newer one.
export function useDraftAutosave({
  kind,
  sourceEmailId,
  accountId,
  content,
  hasContent,
  enabled,
  sensitive = false,
}: Params) {
  const [status, setStatus] = useState<DraftStatus>("idle");
  const slotRef = useRef<Slot>({ id: null, saved: null });
  const pendingRef = useRef<Snapshot | null>(null);
  const timerRef = useRef<number | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const slotKeyRef = useRef<string | null>(null);
  // What the composer held when the email changed: the previous email's text,
  // until the caller clears it. It must never be saved against the new email.
  const carriedOverRef = useRef<string | null>(null);

  const removeDraft = useCallback(async (slot: Slot, keepalive = false) => {
    slot.saved = null;
    const id = slot.id;
    if (id === null) return;
    slot.id = null;
    await deleteEmailDraft(id, { keepalive });
    announce(EMAIL_DRAFT_DELETED_EVENT, id);
  }, []);

  const write = useCallback(
    async (snap: Snapshot, keepalive: boolean) => {
      const { slot } = snap;
      const isCurrent = () => slot === slotRef.current;
      if (!snap.hasContent) {
        await removeDraft(slot, keepalive);
        if (isCurrent()) setStatus("idle");
        return;
      }
      if (slot.saved === snap.json) return;
      if (isCurrent()) setStatus("saving");
      try {
        const options = { keepalive };
        const body = { ...snap.content, account_id: snap.accountId };
        let draft: EmailDraft | null = null;
        if (slot.id !== null) {
          draft = await updateEmailDraft(slot.id, body, options);
        }
        // Null: discarded or sent from another tab. What's on screen is still
        // wanted, so it becomes a draft again rather than being lost.
        draft ??= await createEmailDraft(
          { ...body, kind: snap.kind, source_email_id: snap.sourceEmailId },
          options
        );
        slot.id = draft.id;
        slot.saved = snap.json;
        announce(EMAIL_DRAFT_SAVED_EVENT, draft);
        if (isCurrent()) setStatus("saved");
      } catch (err) {
        logger.warn("Failed to save email draft", err);
        if (isCurrent()) setStatus("error");
        // Try again on the next edit, or at the latest when the composer closes.
        pendingRef.current ??= snap;
      }
    },
    [removeDraft]
  );

  const enqueue = useCallback(
    (snap: Snapshot, keepalive = false) => {
      queueRef.current = queueRef.current
        .then(() => write(snap, keepalive))
        .catch((err) => logger.warn("Email draft save failed", err));
    },
    [write]
  );

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const flush = useCallback(
    (keepalive = false) => {
      clearTimer();
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) enqueue(pending, keepalive);
    },
    [enqueue]
  );

  // Save what's unsaved on the way out of this email, of the open composer, or
  // of the component. Runs before the effect below moves on to a new slot.
  const slotKey = `${kind}:${sourceEmailId ?? "new"}`;
  const json = JSON.stringify(content);
  useEffect(() => {
    if (slotKeyRef.current !== slotKey) {
      if (slotKeyRef.current !== null) {
        slotRef.current = { id: null, saved: null };
        carriedOverRef.current = json;
      }
      slotKeyRef.current = slotKey;
    }
    return () => flush();
    // `json` is read once, at the switch; a keystroke isn't a lifecycle change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey, enabled, flush]);

  useEffect(() => {
    if (json !== carriedOverRef.current) carriedOverRef.current = null;
    if (carriedOverRef.current !== null) {
      pendingRef.current = null;
      return;
    }
    if (!enabled || sensitive) return;
    const slot = slotRef.current;
    if (hasContent ? slot.saved === json : slot.id === null) {
      pendingRef.current = null;
      return;
    }
    pendingRef.current = {
      slot,
      kind,
      sourceEmailId,
      accountId,
      content: JSON.parse(json) as DraftContent,
      json,
      hasContent,
    };
    timerRef.current = window.setTimeout(() => flush(), SAVE_DELAY_MS);
    return clearTimer;
  }, [
    json,
    hasContent,
    enabled,
    sensitive,
    kind,
    sourceEmailId,
    accountId,
    flush,
  ]);

  const discard = useCallback(() => {
    clearTimer();
    pendingRef.current = null;
    const slot = slotRef.current;
    setStatus("idle");
    queueRef.current = queueRef.current
      .then(() => removeDraft(slot))
      .catch((err) => logger.warn("Failed to delete email draft", err));
    return queueRef.current;
  }, [removeDraft]);

  useEffect(() => {
    if (!sensitive) return;
    const timer = window.setTimeout(() => void discard(), 0);
    // Not left to the timer: a save must not leave once the switch is flipped.
    clearTimer();
    pendingRef.current = null;
    return () => window.clearTimeout(timer);
  }, [sensitive, discard]);

  // The one chance to save when the tab closes, or the page is put away on a phone.
  useEffect(() => {
    const onHide = () => flush(true);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [flush]);

  // Carries on from a saved draft: its id is updated from now on, and its content
  // isn't saved again until it changes.
  const adopt = useCallback((draft: EmailDraft) => {
    slotRef.current.id = draft.id;
    slotRef.current.saved = JSON.stringify(contentOf(draft));
    setStatus("saved");
  }, []);

  return { status, adopt, discard };
}

export const draftStatusText = (status: DraftStatus): string =>
  ({
    idle: "",
    saving: "Saving draft…",
    saved: "Draft saved",
    error: "Couldn't save draft",
  })[status];
