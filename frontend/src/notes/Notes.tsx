import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./notes.css";

import {
  createNoteApi,
  deleteNoteApi,
  getNote,
  getNotes,
  NOTES_PAGE_SIZE,
  type Note,
  type NoteSummary,
} from "../api/notes";
import { useGlobalSearch } from "../search/SearchContext";
import { useAuth } from "../auth/useAuth";
import { logger } from "../utils/logger";
import { decryptForSelf } from "../crypto/selfEncrypt";
import { fmtShortDate } from "../utils/datetime";
import NoteBody from "./NoteBody";
import NoteRowMenu from "./NoteRowMenu";
import { useNoteAutosave } from "./useNoteAutosave";
import {
  DEFAULT_NOTE_SORT,
  nextNoteSort,
  noteName,
  sortNotes,
  type NoteSort,
  type NoteSortKey,
} from "./sortNotes";
import {
  forgetOpenNote,
  readOpenNote,
  rememberOpenNote,
} from "./openNoteSession";

const SORT_COLUMNS: { key: NoteSortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "created", label: "Created" },
  { key: "edited", label: "Last edited" },
];

const AUTOSAVE_LABELS = {
  saving: "Saving…",
  saved: "Saved",
  failed: "Not saved, retrying…",
};

export default function Notes() {
  const { normalizedSearchQuery } = useGlobalSearch();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  // The pages of the list loaded so far: names and dates, no text.
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // The saved copy of the open note, text included, fetched when it's opened.
  const [openedNote, setOpenedNote] = useState<Note | null>(null);
  const [loadingNote, setLoadingNote] = useState(false);
  // Only the newest list request and the newest open may land.
  const listRequest = useRef(0);
  const openRequest = useRef(0);
  const [restored] = useState(() => readOpenNote(userId));
  const [selectedId, setSelectedId] = useState<number | "new" | null>(
    restored?.noteId ?? null
  );
  const [title, setTitle] = useState(restored?.title ?? "");
  const [content, setContent] = useState(restored?.content ?? "");
  // A restored form stays unfocused, so typing can't land in the title when the
  // writer was in the body.
  const [focusTitle, setFocusTitle] = useState(restored === null);
  // Whether the body is the raw text field rather than the formatted note.
  const [editing, setEditing] = useState(restored?.editing ?? false);
  const [focusBody, setFocusBody] = useState(false);
  const bodyFieldRef = useRef<HTMLTextAreaElement>(null);
  // A restored note waiting to be checked against the saved copy.
  const uncheckedRef = useRef(
    typeof restored?.noteId === "number" ? restored : null
  );
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [sort, setSort] = useState<NoteSort>(DEFAULT_NOTE_SORT);
  const [view, setView] = useState<"list" | "grid">(() => {
    const saved = window.localStorage.getItem("wayve.notes.view");
    return saved === "grid" ? "grid" : "list";
  });

  useEffect(() => {
    window.localStorage.setItem("wayve.notes.view", view);
  }, [view]);

  // Notes are stored in the clear. decryptForSelf is kept purely to read rows
  // written before that change: it passes a non-envelope string through
  // untouched, so plaintext costs nothing here, and a legacy note stops being
  // ciphertext the first time it is saved again.
  const readable = useCallback(
    async <T extends NoteSummary & { content?: string | null }>(
      note: T
    ): Promise<T> => {
      if (!userId) return note;
      return {
        ...note,
        title: note.title
          ? await decryptForSelf(note.title, userId)
          : note.title,
        ...(note.content
          ? { content: await decryptForSelf(note.content, userId) }
          : {}),
      };
    },
    [userId]
  );

  // Loads the page at `offset`; offset 0 starts the list over. Search and sort
  // run on the server, so changing either reloads from the first page.
  const fetchNotes = useCallback(
    async (offset = 0) => {
      if (!userId) return;
      const request = (listRequest.current += 1);
      try {
        const page = await getNotes({
          limit: NOTES_PAGE_SIZE,
          offset,
          sort: sort.key,
          dir: sort.direction,
          q: normalizedSearchQuery || undefined,
        });
        const rows = await Promise.all(page.notes.map(readable));
        if (request !== listRequest.current) return;
        setNotes((current) =>
          offset === 0
            ? rows
            : [
                ...current,
                ...rows.filter((row) => !current.some((n) => n.id === row.id)),
              ]
        );
        setTotal(page.total);
        setHasMore(page.has_more);
      } catch (err) {
        logger.error(err);
      }
    },
    [userId, sort, normalizedSearchQuery, readable]
  );

  useEffect(() => {
    // Typing a search waits for a pause rather than asking on every key.
    const timeout = window.setTimeout(
      () => {
        void fetchNotes(0);
      },
      normalizedSearchQuery ? 250 : 0
    );

    return () => window.clearTimeout(timeout);
  }, [fetchNotes, normalizedSearchQuery]);

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      await fetchNotes(notes.length);
    } finally {
      setLoadingMore(false);
    }
  };

  // A note restored from the session is checked against its saved copy once.
  useEffect(() => {
    const unchecked = uncheckedRef.current;
    if (!unchecked || typeof unchecked.noteId !== "number" || !userId) return;
    const { noteId, title: oldTitle, content: oldContent } = unchecked;
    let cancelled = false;
    void (async () => {
      try {
        const found = await getNote(noteId);
        const saved = found ? await readable(found) : null;
        if (cancelled) return;
        uncheckedRef.current = null;
        if (saved) setOpenedNote(saved);
        // Edits are kept whatever happened to the note; deleted elsewhere, they
        // become a new note, since there's nothing left to update.
        if (unchecked.edited) {
          if (!saved) {
            setSelectedId((id) => (id === noteId ? "new" : id));
          }
        } else {
          // Only if the writer hasn't moved on, or started typing, in the meantime.
          setSelectedId((id) => (id === noteId && !saved ? null : id));
          setTitle((t) => (t === oldTitle ? (saved?.title ?? "") : t));
          setContent((c) => (c === oldContent ? (saved?.content ?? "") : c));
        }
      } catch (err) {
        logger.error(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, readable]);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 1500);
    return () => clearTimeout(t);
  }, [status]);

  // The header stays up while a note is open, so this can replace one: the
  // same guards as switching notes apply.
  const openNew = async () => {
    if (selectedId === "new") {
      if (
        (title.trim() || content.trim()) &&
        !confirm("Discard this new note?")
      ) {
        return;
      }
    } else if (isEditing && dirty && !(await saveNow())) {
      setStatus("Couldn't save. Check your connection.");
      return;
    }
    openRequest.current += 1;
    setOpenedNote(null);
    setLoadingNote(false);
    setFocusTitle(true);
    setFocusBody(false);
    setEditing(true);
    setSelectedId("new");
    setTitle("");
    setContent("");
  };

  // Opens beside the list, so another note can be picked while one is open. The
  // name shows at once; the text follows from the server.
  const openNote = async (note: NoteSummary) => {
    if (note.id === selectedId) return;
    if (
      selectedId === "new" &&
      (title.trim() || content.trim()) &&
      !confirm("Discard this new note?")
    ) {
      return;
    }
    // Finish saving the note being left, and stay on it if that fails.
    if (isEditing && dirty && !(await saveNow())) {
      setStatus("Couldn't save. Check your connection.");
      return;
    }
    const request = (openRequest.current += 1);
    setFocusTitle(false);
    setFocusBody(false);
    setEditing(false);
    setSelectedId(note.id);
    setTitle(note.title ?? "");
    setContent("");
    setOpenedNote(null);
    setLoadingNote(true);
    try {
      const found = await getNote(note.id);
      const full = found ? await readable(found) : null;
      if (request !== openRequest.current) return;
      if (!full) {
        setNotes((current) => current.filter((n) => n.id !== note.id));
        setTotal((count) => Math.max(0, count - 1));
        closeEditor();
        setStatus("That note was deleted.");
        return;
      }
      setOpenedNote(full);
      setTitle(full.title ?? "");
      setContent(full.content ?? "");
      setNotes((current) =>
        current.map((n) =>
          n.id === full.id
            ? { ...n, title: full.title, updated_at: full.updated_at }
            : n
        )
      );
    } catch (err) {
      logger.error(err);
      if (request !== openRequest.current) return;
      closeEditor();
      setStatus("Couldn't open the note. Check your connection.");
    } finally {
      if (request === openRequest.current) setLoadingNote(false);
    }
  };

  const closeEditor = () => {
    openRequest.current += 1;
    setOpenedNote(null);
    setLoadingNote(false);
    setEditing(false);
    setSelectedId(null);
    setTitle("");
    setContent("");
  };

  // From a row's ⋮ menu. Deleting the open note closes it, unsaved edits and
  // all, since they'd go with the note anyway.
  const deleteNote = async (id: number, name: string) => {
    if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
    try {
      await deleteNoteApi(id);
      setNotes((current) => current.filter((note) => note.id !== id));
      setTotal((count) => Math.max(0, count - 1));
      if (selectedId === id) closeEditor();
      setStatus("Note deleted.");
    } catch (err) {
      logger.error(err);
      setStatus("Couldn't delete. Check your connection.");
    }
  };

  const editBody = () => {
    setFocusBody(true);
    setEditing(true);
  };

  const createNote = async () => {
    if (!title.trim() && !content.trim()) {
      setStatus("Note is empty");
      return;
    }

    setSaving(true);
    try {
      if (!userId) {
        setStatus("Sign-in required");
        return;
      }
      await createNoteApi({ title, content });
      setStatus("Created ✓");
      await fetchNotes(0);
      closeEditor();
    } catch (err) {
      logger.error(err);
      setStatus("Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Already searched and ordered by the server; sorting again keeps a note in
  // place after a save here changes its name or edit time.
  const visibleNotes = useMemo(() => sortNotes(notes, sort), [notes, sort]);

  const editorOpen = selectedId !== null;
  const isEditing = typeof selectedId === "number";
  // A new note has nothing to format yet, so it's always the field.
  const showBodyField = editing || selectedId === "new";
  const split = editorOpen && visibleNotes.length > 0;

  // The field grows with its text, so editing doesn't look like a box.
  useLayoutEffect(() => {
    const field = bodyFieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    // scrollHeight leaves out the box's border; the height includes it.
    const border = field.offsetHeight - field.clientHeight;
    field.style.height = `${field.scrollHeight + border}px`;
  }, [showBodyField, content]);

  // Clicking formatted text can't map to a spot in the raw text: start at the end.
  useLayoutEffect(() => {
    const field = bodyFieldRef.current;
    if (field && focusBody) {
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }, [showBodyField, focusBody]);

  // Autosave is gated on the fields differing from the note they opened (its
  // saved copy, `openedNote`), so opening a note and closing it can't post a
  // no-op update, and nothing is sent before that copy has arrived. Compared
  // raw: what's in the fields is posted without trimming.
  const editingNote =
    isEditing && openedNote?.id === selectedId ? openedNote : undefined;
  const dirty =
    editingNote === undefined ||
    title !== (editingNote.title ?? "") ||
    content !== (editingNote.content ?? "");

  const onAutosaved = useCallback((id: number, fields: Partial<Note>) => {
    setOpenedNote((note) => (note?.id === id ? { ...note, ...fields } : note));
    setNotes((current) =>
      current.map((note) =>
        note.id === id
          ? {
              ...note,
              title: fields.title ?? note.title,
              updated_at: fields.updated_at ?? note.updated_at,
            }
          : note
      )
    );
  }, []);

  const { saveNow, status: autosaveStatus } = useNoteAutosave({
    noteId: isEditing ? selectedId : null,
    title,
    content,
    // A note can't be emptied by accident: blank fields are never sent.
    ready:
      editingNote !== undefined &&
      dirty &&
      (title.trim() !== "" || content.trim() !== ""),
    onSaved: onAutosaved,
  });

  // Stays open if the last changes couldn't be saved, rather than losing them.
  const closeNote = async () => {
    if (await saveNow()) {
      closeEditor();
    } else {
      setStatus("Couldn't save. Check your connection.");
    }
  };

  useEffect(() => {
    if (selectedId === null || !userId) {
      forgetOpenNote();
      return;
    }
    rememberOpenNote({
      userId,
      noteId: selectedId,
      title,
      content,
      // Until the saved copy arrives `dirty` can't tell, so the restored answer
      // stands. A note still opening has nothing typed in it: kept as unedited,
      // coming back replaces its empty text with the saved copy instead of
      // saving it empty.
      edited: uncheckedRef.current
        ? uncheckedRef.current.edited
        : !loadingNote && dirty,
      editing,
    });
  }, [userId, selectedId, title, content, dirty, editing, loadingNote]);

  return (
    <div className="notes-app">
      <main className="notes-main">
        <div className="notes-header notes-header--actions-only">
          <div className="notes-header-actions">
            <span className="notes-count">{total} total</span>
            {/* An open note shows the status in its own header. */}
            {status && !editorOpen && (
              <span className="notes-status">{status}</span>
            )}
            <div className="view-toggle" role="group" aria-label="View mode">
              <button
                type="button"
                className={`view-toggle-btn${view === "list" ? " active" : ""}`}
                onClick={() => setView("list")}
                aria-pressed={view === "list"}
                aria-label="List view"
                data-tooltip="List view"
              >
                ☰
              </button>
              <button
                type="button"
                className={`view-toggle-btn${view === "grid" ? " active" : ""}`}
                onClick={() => setView("grid")}
                aria-pressed={view === "grid"}
                aria-label="Grid view"
                data-tooltip="Grid view"
              >
                ▦
              </button>
            </div>
            <button
              className="notes-new-btn notes-new-btn--inline"
              onClick={() => void openNew()}
            >
              Add new notes
            </button>
          </div>
        </div>

        <div className={`notes-workspace${split ? " is-split" : ""}`}>
          {!(editorOpen && visibleNotes.length === 0) && (
            <div
              className={`notes-list notes-list--${editorOpen ? "names" : view}`}
            >
              {visibleNotes.length === 0 ? (
                <div className="notes-empty">
                  <strong>
                    {normalizedSearchQuery
                      ? "No matching notes"
                      : "No notes yet"}
                  </strong>
                  <span>
                    {normalizedSearchQuery
                      ? "Try a different search term."
                      : "Use Add new notes to add your first note."}
                  </span>
                </div>
              ) : (
                <>
                  <div
                    className="notes-columns"
                    role="group"
                    aria-label="Sort notes"
                  >
                    {SORT_COLUMNS.map(({ key, label }) => {
                      const active = sort.key === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`notes-sort-btn${active ? " is-active" : ""}`}
                          aria-pressed={active}
                          onClick={() =>
                            setSort((current) => nextNoteSort(current, key))
                          }
                        >
                          {label}
                          {active && (
                            <span aria-hidden="true">
                              {sort.direction === "asc" ? " ↑" : " ↓"}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {visibleNotes.map((note) => {
                    const name = noteName(note);
                    const created = fmtShortDate(note.created_at);
                    const edited = fmtShortDate(note.updated_at);
                    return (
                      <div key={note.id} className="note-row">
                        <button
                          type="button"
                          className={`note-card${note.id === selectedId ? " is-active" : ""}`}
                          aria-current={
                            note.id === selectedId ? "true" : undefined
                          }
                          onClick={() => void openNote(note)}
                          aria-label={`Edit ${name}. Created ${created}. Last edited ${edited}.`}
                        >
                          <span className="note-card-title">{name}</span>
                          {!editorOpen && view === "list" && (
                            <>
                              <span className="note-card-date">{created}</span>
                              <span className="note-card-date">{edited}</span>
                            </>
                          )}
                        </button>
                        <NoteRowMenu
                          label={name}
                          onDelete={() => void deleteNote(note.id, name)}
                        />
                      </div>
                    );
                  })}
                  {hasMore && (
                    <button
                      type="button"
                      className="notes-more-btn"
                      onClick={() => void loadMore()}
                      disabled={loadingMore}
                    >
                      {loadingMore ? "Loading…" : "Show more"}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {editorOpen && (
            <form
              className="note-read"
              onSubmit={(event) => {
                event.preventDefault();
                if (isEditing) void saveNow();
                else void createNote();
              }}
            >
              <header className="note-read-header">
                <input
                  className="note-title-input"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onBlur={() => void saveNow()}
                  // Edits wait for the saved copy, so they can't be lost to it.
                  readOnly={loadingNote}
                  placeholder="Enter note title"
                  aria-label="Title"
                  autoFocus={focusTitle}
                />
                {/* A new note's Cancel and Create sit below its text instead. */}
                {isEditing && (
                  <div className="notes-form-actions">
                    {status && (
                      <span className="note-save-state" role="status">
                        {status}
                      </span>
                    )}
                    {autosaveStatus !== "idle" && (
                      <span className="note-save-state" role="status">
                        {AUTOSAVE_LABELS[autosaveStatus]}
                      </span>
                    )}
                    <button
                      type="button"
                      className="note-close-btn"
                      onClick={() => void closeNote()}
                      aria-label="Close"
                      data-tooltip="Close"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </header>

              {loadingNote ? (
                <p className="note-read-empty" role="status">
                  Loading…
                </p>
              ) : showBodyField ? (
                <textarea
                  ref={bodyFieldRef}
                  className="note-body-input"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  onBlur={() => {
                    setEditing(false);
                    void saveNow();
                  }}
                  placeholder="Start writing…"
                  aria-label="Note text"
                  autoFocus={focusBody}
                />
              ) : (
                <div
                  className="note-body-view"
                  role="button"
                  tabIndex={0}
                  aria-label="Edit note text"
                  onClick={() => {
                    // Dragging across the text to copy it isn't a click to edit.
                    if (!window.getSelection()?.toString()) editBody();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      editBody();
                    }
                  }}
                >
                  {content.trim() ? (
                    <NoteBody content={content} />
                  ) : (
                    <p className="note-read-empty">Click to add text</p>
                  )}
                </div>
              )}

              {!isEditing && (
                <div className="notes-form-actions note-create-actions">
                  {status && (
                    <span className="note-save-state" role="status">
                      {status}
                    </span>
                  )}
                  <button type="button" onClick={closeEditor} disabled={saving}>
                    Cancel
                  </button>
                  <button type="submit" className="primary" disabled={saving}>
                    {saving ? "Creating…" : "Create note"}
                  </button>
                </div>
              )}
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
