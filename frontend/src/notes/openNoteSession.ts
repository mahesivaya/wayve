// The note being written outlives the Notes page: every route change unmounts it,
// so without this coming back from Chat loses the title and body. Notes are stored
// in the clear, so unlike a chat draft this can hold the text. sessionStorage
// outlives a logout within the tab, so the entry names its owner and AuthContext
// clears it on logout and session expiry.
const STORAGE_KEY = "rwayve.notes.open";

export type OpenNoteSession = {
  userId: number;
  noteId: number | "new";
  title: string;
  content: string;
  // Whether the text differs from the saved note. If it doesn't, the note may have
  // changed elsewhere since, so returning shows the saved copy instead.
  edited: boolean;
};

export function readOpenNote(
  userId: number | null | undefined
): OpenNoteSession | null {
  if (userId === null || userId === undefined) return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OpenNoteSession> | null;
    if (
      !parsed ||
      parsed.userId !== userId ||
      (parsed.noteId !== "new" && typeof parsed.noteId !== "number") ||
      typeof parsed.title !== "string" ||
      typeof parsed.content !== "string"
    ) {
      return null;
    }
    return {
      userId,
      noteId: parsed.noteId,
      title: parsed.title,
      content: parsed.content,
      edited: parsed.edited === true,
    };
  } catch {
    return null;
  }
}

export function rememberOpenNote(open: OpenNoteSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(open));
  } catch {
    // private mode / quota — the note just won't come back on return.
  }
}

export function forgetOpenNote(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore — private mode / quota
  }
}
