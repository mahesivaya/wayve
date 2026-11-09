import type { Note } from "../api/notes";

export type NoteSortKey = "name" | "created" | "edited";
export type NoteSortDirection = "asc" | "desc";
export type NoteSort = { key: NoteSortKey; direction: NoteSortDirection };

// Matches the order the API returns.
export const DEFAULT_NOTE_SORT: NoteSort = { key: "edited", direction: "desc" };

export const noteName = (note: Note) => note.title?.trim() || "Untitled";

const timeOf = (iso: string | null | undefined) => {
  const time = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(time) ? 0 : time;
};

// `numeric` puts "Note 2" before "Note 10"; `base` ignores case and accents.
const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function sortNotes(notes: Note[], sort: NoteSort): Note[] {
  const compare = (a: Note, b: Note) => {
    if (sort.key === "name")
      return nameCollator.compare(noteName(a), noteName(b));
    if (sort.key === "created")
      return timeOf(a.created_at) - timeOf(b.created_at);
    return timeOf(a.updated_at) - timeOf(b.updated_at);
  };
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...notes].sort((a, b) => sign * compare(a, b));
}

// Clicking the active column flips it. A new column starts where people expect:
// names A to Z, dates newest first.
export function nextNoteSort(current: NoteSort, key: NoteSortKey): NoteSort {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: key === "name" ? "asc" : "desc" };
}
