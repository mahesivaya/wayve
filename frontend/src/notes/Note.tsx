import { useEffect, useState } from "react";

import "./notes.css";

import {
  createNoteApi,
  deleteNoteApi,
  getNotes,
  updateNoteApi,
  type Note,
} from "../api/notes";
import { logger } from "../utils/logger";

type EditableNote = Note & {
  title: string;
  content: string;
};

export default function Notes() {
  const [notes, setNotes] = useState<EditableNote[]>([]);
  const [selected, setSelected] = useState<EditableNote | null>(null);

  // ================= FETCH NOTES =================

  useEffect(() => {
    const loadNotes = async () => {
      try {
        const data = await getNotes();
        setNotes(
          data.map((note) => ({
            ...note,
            title: note.title ?? "",
            content: note.content ?? "",
          }))
        );

      } catch (err) {
        logger.error(err);
      }
    };
    void loadNotes();
  }, []);

  // ================= CREATE =================

  const createNote = async () => {
    try {
      const saved = await createNoteApi({
        title: "",
        content: "",
      });
      const newNote: EditableNote = {
        ...saved,
        title: saved.title ?? "",
        content: saved.content ?? "",
      };
      setNotes((prev) => [
        newNote,
        ...prev,
      ]);
      setSelected(newNote);
    } catch (err) {
      logger.error(err);
    }
  };

  // ================= UPDATE (LOCAL STATE) =================

    const handleChange = (value: string) => {if (!selected) {return;}
    const updated = {...selected, content: value};
    setSelected(updated);
    setNotes((prev) =>
      prev.map((n) =>
        n.id === updated.id
          ? updated
          : n
      )
    );
  };

  // ================= AUTOSAVE =================

  useEffect(() => {
    if (!selected) {
      return;
    }

    // Debounced save of the in-flight note. Inlined rather than a separate
    // `saveNote` declared below, which would be referenced before declaration.
    const note = selected;
    const timeout = setTimeout(() => {
      void updateNoteApi(note.id, {
        title: note.title,
        content: note.content,
      }).catch((err) => {
        logger.error(err);
      });
    }, 800);
    return () => clearTimeout(timeout);
  }, [selected]);

  // ================= DELETE =================

  const deleteNote = async (
    id: number
  ) => {
    try {
      await deleteNoteApi(id);

      setNotes((prev) =>
        prev.filter(
          (n) => n.id !== id
        )
      );

      if (selected?.id === id) {
        setSelected(null);
      }

    } catch (err) {
      logger.error(err);
    }
  };

  return (
    <div className="notes-container">

      {/* Sidebar */}

      <div className="notes-sidebar">
        <button onClick={() => void createNote()}>
          + New
        </button>

        {notes.map((n) => (
          <div
            key={n.id}

            onClick={() =>
              setSelected(n)
            }
          >
            {n.title ||
              "Untitled"}
          </div>
        ))}
      </div>

      {/* Editor */}

      <div className="notes-editor">
        {selected ? (
          <>
            <input
              placeholder="Title"

              value={selected.title}

              onChange={(e) =>
                setSelected({
                  ...selected,
                  title:
                    e.target.value,
                })
              }
            />

            <textarea
              value={selected.content}

              onChange={(e) =>
                handleChange(
                  e.target.value
                )
              }
            />

            <button onClick={() => void deleteNote(selected.id)}>
              Delete
            </button>
          </>

        ) : (
          <div>
            Select a note
          </div>
        )}
      </div>
    </div>
  );
}
