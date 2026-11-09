import { describe, expect, it } from "vitest";
import type { Note } from "../../api/notes";
import {
  DEFAULT_NOTE_SORT,
  nextNoteSort,
  sortNotes,
} from "../../notes/sortNotes";

const note = (
  id: number,
  title: string | null,
  created_at: string | null,
  updated_at: string | null
): Note => ({ id, title, content: "", created_at, updated_at });

const ids = (notes: Note[]) => notes.map((n) => n.id);

const notes = [
  note(1, "banana", "2026-01-02T00:00:00", "2026-03-01T00:00:00"),
  note(2, "Apple", "2026-01-03T00:00:00", "2026-02-01T00:00:00"),
  note(3, "cherry", "2026-01-01T00:00:00", "2026-04-01T00:00:00"),
];

describe("sortNotes", () => {
  it("sorts names alphabetically, ignoring case", () => {
    expect(ids(sortNotes(notes, { key: "name", direction: "asc" }))).toEqual([
      2, 1, 3,
    ]);
    expect(ids(sortNotes(notes, { key: "name", direction: "desc" }))).toEqual([
      3, 1, 2,
    ]);
  });

  it("orders numbers in names by value", () => {
    const numbered = [
      note(1, "Note 10", null, null),
      note(2, "Note 2", null, null),
    ];
    expect(ids(sortNotes(numbered, { key: "name", direction: "asc" }))).toEqual(
      [2, 1]
    );
  });

  it("files a blank title under Untitled", () => {
    const blank = [note(1, "Zebra", null, null), note(2, "  ", null, null)];
    expect(ids(sortNotes(blank, { key: "name", direction: "asc" }))).toEqual([
      2, 1,
    ]);
  });

  it("sorts by created date", () => {
    expect(
      ids(sortNotes(notes, { key: "created", direction: "desc" }))
    ).toEqual([2, 1, 3]);
    expect(ids(sortNotes(notes, { key: "created", direction: "asc" }))).toEqual(
      [3, 1, 2]
    );
  });

  it("defaults to the most recently edited first", () => {
    expect(ids(sortNotes(notes, DEFAULT_NOTE_SORT))).toEqual([3, 1, 2]);
  });

  it("does not reorder the array it was given", () => {
    const input = [...notes];
    sortNotes(input, { key: "name", direction: "asc" });
    expect(ids(input)).toEqual([1, 2, 3]);
  });
});

describe("nextNoteSort", () => {
  it("flips direction on the active column", () => {
    expect(nextNoteSort({ key: "name", direction: "asc" }, "name")).toEqual({
      key: "name",
      direction: "desc",
    });
  });

  it("starts names A to Z and dates newest first", () => {
    expect(nextNoteSort(DEFAULT_NOTE_SORT, "name").direction).toBe("asc");
    expect(
      nextNoteSort({ key: "name", direction: "asc" }, "created").direction
    ).toBe("desc");
  });
});
