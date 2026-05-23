import { useCallback, useEffect, useRef, useState } from "react";
import "./notes.css";

import {
  createNoteApi,
  deleteNoteApi,
  getNotes,
  updateNoteApi,
  type Note,
} from "../api/notes";
import { useGlobalSearch } from "../search/SearchContext";
import { useAuth } from "../auth/useAuth";
import {
  decryptForSelf,
  encryptForSelf,
} from "../crypto/selfEncrypt";


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

  // Narrow mode (split pane / small viewport): stack list + editor.
  const mainRef = useRef<HTMLDivElement>(null);
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsNarrow(entry.contentRect.width < 700);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ================= LOAD =================
  // The backend stores notes as opaque WAYVE_SECURE_V1 envelopes; decrypt
  // each row's title and content client-side before they ever reach React
  // state. Pre-E2E plaintext rows pass through untouched (see
  // `isSelfEncrypted` short-circuit in decryptForSelf).
  const fetchNotes = useCallback(async () => {
    if (!userId) return;
    try {
      const raw = await getNotes();
      const decrypted = await Promise.all(
        raw.map(async (note) => ({
          ...note,
          title: note.title ? await decryptForSelf(note.title, userId) : note.title,
          content: note.content ? await decryptForSelf(note.content, userId) : note.content,
        }))
      );
      setNotes(decrypted);
    } catch (err) {
      console.error(err);
    }
  }, [userId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void fetchNotes();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [fetchNotes]);

  // Drop transient status banners after a moment.
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 1500);
    return () => clearTimeout(t);
  }, [status]);

  // ================= SELECT =================
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

  // ================= SAVE =================
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
      // Wrap title and content in WAYVE_SECURE_V1 envelopes so the
      // server only ever sees ciphertext. `encryptForSelf` returns ""
      // for empty input, which the backend handler stores as the empty
      // string — matches the pre-E2E behavior of `data.content.unwrap_or("")`.
      const cipherTitle = await encryptForSelf(title, userId);
      const cipherContent = await encryptForSelf(content, userId);

      const isNew = selectedId === "new" || selectedId === null;
      const saved = isNew
        ? await createNoteApi({ title: cipherTitle, content: cipherContent })
        : await updateNoteApi(selectedId, { title: cipherTitle, content: cipherContent });
      setSelectedId(saved.id);
      setStatus(isNew ? "Created ✓" : "Saved ✓");
      await fetchNotes();
    } catch (err) {
      console.error(err);
      setStatus(
        err instanceof Error && err.message.includes("public key")
          ? "Generate an encryption key first (see chat setup)"
          : "Save failed"
      );
    } finally {
      setSaving(false);
    }
  };

  // ================= DELETE =================
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
    } catch
    {
      setStatus("Delete failed")
    }
  };

  const editorOpen = selectedId !== null;
  const showList = !isNarrow || !editorOpen;
  const showEditor = !isNarrow || editorOpen;
  const visibleNotes = normalizedSearchQuery
    ? notes.filter((note) =>
        [note.title ?? "", note.content ?? "", note.updated_at ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearchQuery)
      )
    : notes;

  // ================= UI =================
  return (
    <div ref={mainRef} className={`notes ${isNarrow ? "narrow" : ""}`}>
      {/* LIST */}
      {showList && (
        <div className="notes-list">
          <button className="notes-new-btn" onClick={openNew}>
            + New Note
          </button>

          {visibleNotes.length === 0 && (
            <div className="notes-empty">
              {normalizedSearchQuery ? "No notes match your search" : "No notes yet"}
            </div>
          )}

          {visibleNotes.map((n) => (
            <div
              key={n.id}
              className={`notes-item ${selectedId === n.id ? "active" : ""}`}
              onClick={() => openNote(n)}
            >
              <div className="notes-item-title">
                {n.title?.trim() || "Untitled"}
              </div>
              <div className="notes-item-preview">
                {(n.content ?? "").slice(0, 80)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* EDITOR */}
      {showEditor && (
        <div className="notes-editor">
          {!editorOpen ? (
            <div className="notes-editor-empty">
              <div className="notes-editor-empty-icon">📝</div>
              <div>Select a note or create a new one</div>
            </div>
          ) : (
            <>
              <div className="notes-editor-header">
                {isNarrow && (
                  <button
                    className="notes-back-btn"
                    onClick={closeEditor}
                    title="Back to list"
                    aria-label="Back to list"
                  >
                    ←
                  </button>
                )}
                <input
                  className="notes-title-input"
                  placeholder="Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                {status && <span className="notes-status">{status}</span>}
              </div>

              <textarea
                className="notes-body-input"
                placeholder="Start writing…"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />

              <div className="notes-editor-actions">
                <button
                  className="notes-save-btn"
                  onClick={save}
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                {selectedId !== "new" && (
                  <button className="notes-delete-btn" onClick={remove}>
                    Delete
                  </button>
                )}
                <button className="notes-cancel-btn" onClick={closeEditor}>
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
