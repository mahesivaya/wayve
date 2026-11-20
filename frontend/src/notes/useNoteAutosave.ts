import { useCallback, useEffect, useRef, useState } from "react";
import { updateNoteApi, type Note } from "../api/notes";
import { logger } from "../utils/logger";
import { markOpenNoteSaved } from "./openNoteSession";

const AUTOSAVE_DELAY_MS = 800;
const RETRY_DELAY_MS = 5000;
const SAVED_VISIBLE_MS = 1500;

export type AutosaveStatus = "idle" | "saving" | "saved" | "failed";

type Options = {
  noteId: number | null;
  title: string;
  content: string;
  // There are changes worth sending: the saved note has loaded and differs.
  ready: boolean;
  onSaved: (id: number, fields: Partial<Note>) => void;
};

// Saves the open note a moment after typing stops, and at once when `saveNow` is
// called or the page unmounts. Saves run one at a time, in order, so a slow early
// request can't land after a later one and put old text back.
export function useNoteAutosave({
  noteId,
  title,
  content,
  ready,
  onSaved,
}: Options) {
  const [result, setResult] = useState<{
    noteId: number | null;
    status: AutosaveStatus;
  }>({ noteId: null, status: "idle" });
  const [retryTick, setRetryTick] = useState(0);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  // What was last queued, so a blur right after the timer doesn't send it twice.
  const lastQueued = useRef<string | null>(null);
  const latest = useRef({ noteId, title, content, ready, onSaved });

  useEffect(() => {
    latest.current = { noteId, title, content, ready, onSaved };
  });

  // Resolves true once everything queued has reached the server.
  const saveNow = useCallback((): Promise<boolean> => {
    const { noteId: id, title: t, content: c, ready: ok } = latest.current;
    if (!ok || id === null) return Promise.resolve(true);

    const key = JSON.stringify([id, t, c]);
    if (key === lastQueued.current) return chain.current;
    lastQueued.current = key;

    setResult({ noteId: id, status: "saving" });
    chain.current = chain.current.then(async () => {
      try {
        const saved = await updateNoteApi(id, { title: t, content: c });
        latest.current.onSaved(id, {
          title: t,
          content: c,
          updated_at: saved.updated_at,
        });
        markOpenNoteSaved(id, t, c);
        // A newer edit is already queued if this isn't the last one.
        if (lastQueued.current === key) {
          setResult({ noteId: id, status: "saved" });
        }
        return true;
      } catch (err) {
        logger.error(err);
        if (lastQueued.current === key) lastQueued.current = null;
        setResult({ noteId: id, status: "failed" });
        window.setTimeout(
          () => setRetryTick((tick) => tick + 1),
          RETRY_DELAY_MS
        );
        return false;
      }
    });
    return chain.current;
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => void saveNow(), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [ready, noteId, title, content, retryTick, saveNow]);

  // "Saved" is a brief confirmation, not a permanent label.
  useEffect(() => {
    if (result.status !== "saved") return;
    const timer = window.setTimeout(
      () =>
        setResult((current) =>
          current.status === "saved" ? { ...current, status: "idle" } : current
        ),
      SAVED_VISIBLE_MS
    );
    return () => window.clearTimeout(timer);
  }, [result]);

  // Leaving the page must not drop the last few keystrokes.
  useEffect(
    () => () => {
      void saveNow();
    },
    [saveNow]
  );

  return {
    saveNow,
    status: result.noteId === noteId ? result.status : "idle",
  };
}
