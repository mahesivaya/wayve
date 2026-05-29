import { useCallback, useEffect, useMemo, useState } from "react";
import "./notes.css";

import {
  createNoteApi,
  deleteNoteApi,
  getNotes,
  updateNoteApi,
  type Note,
} from "../api/notes";
import { useGlobalSearch } from "../search/SearchContext";
import SearchBar from "../search/SearchBar";
import { useAuth } from "../auth/useAuth";
import { logger } from "../utils/logger";
import { decryptForSelf, encryptForSelf } from "../crypto/selfEncrypt";
import { fmtShortDate } from "../utils/datetime";

const formatDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  return fmtShortDate(iso);
};

export default function Notes() {
  const { normalizedSearchQuery } = useGlobalSearch();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<number | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
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
      const decrypted = await Promise.all(
        raw.map(async (note) => ({
          ...note,
          title: note.title
            ? await decryptForSelf(note.title, userId)
            : note.title,
          content: note.content
            ? await decryptForSelf(note.content, userId)
            : note.content,
        })),
      );
      setNotes(decrypted);
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
    setSelectedId("new");
    setTitle("");
    setContent("");
  };

  const openNote = (note: Note) => {
    setSelectedId(note.id);
    setTitle(note.title ?? "");
    setContent(note.content ?? "");
  };

  const closeEditor = () => {
    setSelectedId(null);
    setTitle("");
    setContent("");
  };

  const save = async () => {
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
      // Wrap title + content in WAYVE_SECURE_V1 envelopes so the server
      // only ever sees ciphertext (see decryptForSelf in fetchNotes).
      const cipherTitle = await encryptForSelf(title, userId);
      const cipherContent = await encryptForSelf(content, userId);

      const isNew = selectedId === "new" || selectedId === null;
      const saved = isNew
        ? await createNoteApi({
            title: cipherTitle,
            content: cipherContent,
          })
        : await updateNoteApi(selectedId, {
            title: cipherTitle,
            content: cipherContent,
          });
      setSelectedId(saved.id);
      setStatus(isNew ? "Created ✓" : "Saved ✓");
      await fetchNotes();
      closeEditor();
    } catch (err) {
      logger.error(err);
      setStatus(
        err instanceof Error && err.message.includes("public key")
          ? "Generate an encryption key first (see chat setup)"
          : "Save failed",
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (selectedId === null || selectedId === "new") {
      closeEditor();
      return;
    }
    if (!confirm("Delete this note?")) return;
    try {
      await deleteNoteApi(selectedId);
      closeEditor();
      setStatus("Deleted");
      await fetchNotes();
    } catch {
      setStatus("Delete failed");
    }
  };

  const editorOpen = selectedId !== null;
  const isEditing = typeof selectedId === "number";

  const visibleNotes = useMemo(() => {
    if (!normalizedSearchQuery) return notes;
    return notes.filter((note) =>
      [note.title ?? "", note.content ?? "", note.updated_at ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearchQuery),
    );
  }, [normalizedSearchQuery, notes]);

  return (
    <div className="notes-app">
      <main className="notes-main">
        <div className="notes-header">
          <div>
            <h2>Notes</h2>
            <p>Quick personal notes, encrypted on your device.</p>
          </div>
        </div>

        <div className="notes-toolbar">
          <SearchBar />
        </div>

        <div className="notes-header notes-header--actions-only">
          <div className="notes-header-actions">
            <span className="notes-count">{notes.length} total</span>
            {status && <span className="notes-status">{status}</span>}
            {!editorOpen && (
              <div className="view-toggle" role="group" aria-label="View mode">
                <button
                  type="button"
                  className={`view-toggle-btn${view === "list" ? " active" : ""}`}
                  onClick={() => setView("list")}
                  aria-pressed={view === "list"}
                  aria-label="List view"
                  title="List view"
                >
                  ☰
                </button>
                <button
                  type="button"
                  className={`view-toggle-btn${view === "grid" ? " active" : ""}`}
                  onClick={() => setView("grid")}
                  aria-pressed={view === "grid"}
                  aria-label="Grid view"
                  title="Grid view"
                >
                  ▦
                </button>
              </div>
            )}
            {!editorOpen && (
              <button
                className="notes-new-btn notes-new-btn--inline"
                onClick={openNew}
              >
                + New note
              </button>
            )}
          </div>
        </div>

        {editorOpen && (
          <form
            className="notes-edit-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="notes-form-grid">
              <label>
                <span>Title</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Enter note title"
                  autoFocus
                />
              </label>

              <label>
                <span>Body</span>
                <textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="Start writing…"
                />
              </label>
            </div>

            <div className="notes-form-actions">
              <button
                type="button"
                onClick={closeEditor}
                disabled={saving}
              >
                Cancel
              </button>
              {isEditing && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => void remove()}
                  disabled={saving}
                >
                  Delete
                </button>
              )}
              <button type="submit" className="primary" disabled={saving}>
                {saving
                  ? isEditing
                    ? "Saving…"
                    : "Creating…"
                  : isEditing
                    ? "Save changes"
                    : "Create note"}
              </button>
            </div>
          </form>
        )}

        {!editorOpen && (
          <div className={`notes-list notes-list--${view}`}>
            {visibleNotes.length === 0 ? (
              <div className="notes-empty">
                <strong>
                  {notes.length === 0 ? "No notes yet" : "No matching notes"}
                </strong>
                <span>
                  {notes.length === 0
                    ? "Use + New note to add your first note."
                    : "Try a different search term."}
                </span>
              </div>
            ) : (
              visibleNotes.map((note) => (
                <article
                  key={note.id}
                  className="note-card"
                  onClick={() => openNote(note)}
                >
                  <div className="note-card-body">
                    <h3>{note.title?.trim() || "Untitled"}</h3>
                    <p>{(note.content ?? "").slice(0, 160) || "No content."}</p>
                  </div>
                  <div className="note-card-meta">
                    {note.updated_at && (
                      <time dateTime={note.updated_at}>
                        {formatDate(note.updated_at)}
                      </time>
                    )}
                    <div className="note-card-actions">
                      <button
                        type="button"
                        className="note-edit-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          openNote(note);
                        }}
                        aria-label={`Edit ${note.title || "note"}`}
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>
        )}
      </main>
    </div>
  );
}
