import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./notes.css";

import { createNoteApi, getNotes, type Note } from "../api/notes";
import { useGlobalSearch } from "../search/SearchContext";
import { useAuth } from "../auth/useAuth";
import { logger } from "../utils/logger";
import { decryptForSelf } from "../crypto/selfEncrypt";
import { fmtShortDate } from "../utils/datetime";
import NoteBody from "./NoteBody";
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
  const [notes, setNotes] = useState<Note[]>([]);
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

  const fetchNotes = useCallback(async () => {
    if (!userId) return;
    try {
      const raw = await getNotes();
      // Notes are stored in the clear. decryptForSelf is kept purely to read
      // rows written before that change: it passes a non-envelope string
      // through untouched, so plaintext costs nothing here, and a legacy note
      // stops being ciphertext the first time it is saved again.
      const readable = await Promise.all(
        raw.map(async (note) => ({
          ...note,
          title: note.title
            ? await decryptForSelf(note.title, userId)
            : note.title,
          content: note.content
            ? await decryptForSelf(note.content, userId)
            : note.content,
        }))
      );
      setNotes(readable);

      const unchecked = uncheckedRef.current;
      uncheckedRef.current = null;
      if (unchecked) {
        const { noteId, title: oldTitle, content: oldContent } = unchecked;
        const saved = readable.find((note) => note.id === noteId);
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
      }
    } catch (err) {
      logger.error(err);
    }
  }, [userId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void fetchNotes();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [fetchNotes]);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 1500);
    return () => clearTimeout(t);
  }, [status]);

  const openNew = () => {
    setFocusTitle(true);
    setFocusBody(false);
    setEditing(true);
    setSelectedId("new");
    setTitle("");
    setContent("");
  };

  // Opens beside the list, so another note can be picked while one is open.
  const openNote = async (note: Note) => {
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
    setFocusTitle(false);
    setFocusBody(false);
    setEditing(false);
    setSelectedId(note.id);
    setTitle(note.title ?? "");
    setContent(note.content ?? "");
  };

  const closeEditor = () => {
    setEditing(false);
    setSelectedId(null);
    setTitle("");
    setContent("");
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
      await fetchNotes();
      closeEditor();
    } catch (err) {
      logger.error(err);
      setStatus("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const visibleNotes = useMemo(() => {
    const matching = normalizedSearchQuery
      ? notes.filter((note) =>
          [note.title ?? "", note.content ?? "", note.updated_at ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(normalizedSearchQuery)
        )
      : notes;
    return sortNotes(matching, sort);
  }, [normalizedSearchQuery, notes, sort]);

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
    field.style.height = `${field.scrollHeight}px`;
  }, [showBodyField, content]);

  // Clicking formatted text can't map to a spot in the raw text: start at the end.
  useLayoutEffect(() => {
    const field = bodyFieldRef.current;
    if (field && focusBody) {
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }, [showBodyField, focusBody]);

  // Autosave is gated on the fields differing from the note they opened (the copy
  // in `notes`), so opening a note and closing it can't post a no-op update.
  // Compared raw: what's in the fields is posted without trimming.
  const editingNote = isEditing
    ? notes.find((note) => note.id === selectedId)
    : undefined;
  const dirty =
    editingNote === undefined ||
    title !== (editingNote.title ?? "") ||
    content !== (editingNote.content ?? "");

  const onAutosaved = useCallback((id: number, fields: Partial<Note>) => {
    setNotes((current) =>
      current.map((note) => (note.id === id ? { ...note, ...fields } : note))
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
      // Until the list arrives `dirty` can't tell, so the restored answer stands.
      edited: uncheckedRef.current ? uncheckedRef.current.edited : dirty,
      editing,
    });
  }, [userId, selectedId, title, content, dirty, editing]);

  return (
    <div className="notes-app">
      <main className="notes-main">
        {!editorOpen && (
          <div className="notes-header notes-header--actions-only">
            <div className="notes-header-actions">
              <span className="notes-count">{notes.length} total</span>
              {status && <span className="notes-status">{status}</span>}
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
                onClick={openNew}
              >
                Add new notes
              </button>
            </div>
          </div>
        )}

        <div className={`notes-workspace${split ? " is-split" : ""}`}>
          {!(editorOpen && visibleNotes.length === 0) && (
            <div
              className={`notes-list notes-list--${editorOpen ? "names" : view}`}
            >
              {visibleNotes.length === 0 ? (
                <div className="notes-empty">
                  <strong>
                    {notes.length === 0 ? "No notes yet" : "No matching notes"}
                  </strong>
                  <span>
                    {notes.length === 0
                      ? "Use Add new notes to add your first note."
                      : "Try a different search term."}
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
                      <button
                        key={note.id}
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
                    );
                  })}
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
                  placeholder="Enter note title"
                  aria-label="Title"
                  autoFocus={focusTitle}
                />
                <div className="notes-form-actions">
                  {status && (
                    <span className="note-save-state" role="status">
                      {status}
                    </span>
                  )}
                  {isEditing ? (
                    <>
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
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={closeEditor}
                        disabled={saving}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="primary"
                        disabled={saving}
                      >
                        {saving ? "Creating…" : "Create note"}
                      </button>
                    </>
                  )}
                </div>
              </header>

              {showBodyField ? (
                <>
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
                  <small className="notes-format-hint">
                    # Heading &nbsp;·&nbsp; ## Smaller heading &nbsp;·&nbsp; -
                    Bullet (indent to nest) &nbsp;·&nbsp; 1. Numbered
                    &nbsp;·&nbsp; **bold**
                  </small>
                </>
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
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
