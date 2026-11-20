// The note being written comes back after leaving the page: the title and body are
// restored from sessionStorage when the real Notes page mounts again.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const api = vi.hoisted(() => ({
  NOTES_PAGE_SIZE: 50,
  getNotes: vi.fn(),
  getNote: vi.fn(),
  createNoteApi: vi.fn(),
  updateNoteApi: vi.fn(),
  deleteNoteApi: vi.fn(),
}));
const auth = vi.hoisted(() => ({ user: { id: 1 } as { id: number } | null }));

vi.mock("../../api/notes", () => api);
vi.mock("../../auth/useAuth", () => ({ useAuth: () => auth }));
vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ normalizedSearchQuery: "" }),
}));
vi.mock("../../search/SearchBar", () => ({ default: () => null }));
vi.mock("../../crypto/selfEncrypt", () => ({
  decryptForSelf: (text: string) => Promise.resolve(text),
}));

import Notes from "../../notes/Notes";
import { forgetOpenNote, readOpenNote } from "../../notes/openNoteSession";

const KEY = "rwayve.notes.open";
const saved = (id: number, title: string, content: string) => ({
  id,
  title,
  content,
  updated_at: "2026-11-01T12:00:00Z",
});
type Saved = ReturnType<typeof saved>;

// What the server holds: the list gives names only, and a note's text comes
// from getNote when it's opened.
const setStore = (rows: Saved[]) => {
  api.getNotes.mockResolvedValue({
    notes: rows.map(({ content: _content, ...summary }) => summary),
    total: rows.length,
    has_more: false,
  });
  api.getNote.mockImplementation((id: number) =>
    Promise.resolve(rows.find((row) => row.id === id) ?? null)
  );
};

const titleField = () =>
  screen.getByPlaceholderText("Enter note title") as HTMLInputElement;
const bodyField = () =>
  screen.getByPlaceholderText("Start writing…") as HTMLTextAreaElement;
const type = (field: HTMLElement, value: string) =>
  fireEvent.change(field, { target: { value } });

const startNewNote = async () => {
  render(<Notes />);
  await screen.findByText("Add new notes");
  fireEvent.click(screen.getByText("Add new notes"));
};
// Leaving the page unmounts it; coming back mounts a new one.
const leaveAndReturn = async () => {
  cleanup();
  render(<Notes />);
  await waitFor(() => expect(api.getNotes).toHaveBeenCalledTimes(2));
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  auth.user = { id: 1 };
  setStore([]);
  api.createNoteApi.mockResolvedValue(saved(9, "t", "c"));
  api.updateNoteApi.mockResolvedValue(saved(5, "t", "c"));
  api.deleteNoteApi.mockResolvedValue(undefined);
});

describe("a new note", () => {
  it("keeps its title and body after leaving and coming back", async () => {
    await startNewNote();
    type(titleField(), "Half a title");
    type(bodyField(), "Half a body");
    await leaveAndReturn();
    expect(titleField().value).toBe("Half a title");
    expect(bodyField().value).toBe("Half a body");
    expect(screen.getByRole("button", { name: "Create note" })).toBeTruthy();
    expect(api.createNoteApi).not.toHaveBeenCalled();
  });

  it("doesn't take focus when it comes back, but a fresh form does", async () => {
    await startNewNote();
    expect(document.activeElement).toBe(titleField());
    type(bodyField(), "Body");
    await leaveAndReturn();
    expect(document.activeElement).not.toBe(titleField());
    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(screen.getByText("Add new notes"));
    expect(document.activeElement).toBe(titleField());
  });

  it("can be created after coming back, which ends the keeping", async () => {
    await startNewNote();
    type(titleField(), "Title");
    type(bodyField(), "Body");
    await leaveAndReturn();
    fireEvent.click(screen.getByRole("button", { name: "Create note" }));
    await waitFor(() =>
      expect(api.createNoteApi).toHaveBeenCalledWith({
        title: "Title",
        content: "Body",
      })
    );
    await screen.findByText("Add new notes");
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("is forgotten on Cancel", async () => {
    await startNewNote();
    type(titleField(), "Never mind");
    fireEvent.click(screen.getByText("Cancel"));
    expect(sessionStorage.getItem(KEY)).toBeNull();
    await leaveAndReturn();
    expect(screen.queryByPlaceholderText("Enter note title")).toBeNull();
  });

  it("stays when saving fails", async () => {
    api.createNoteApi.mockRejectedValue(new Error("down"));
    await startNewNote();
    type(titleField(), "Keep me");
    fireEvent.click(screen.getByRole("button", { name: "Create note" }));
    await screen.findByText("Save failed");
    await leaveAndReturn();
    expect(titleField().value).toBe("Keep me");
  });
});

describe("an existing note", () => {
  // Opening fetches the text; this waits until it's showing.
  const open = async (button: HTMLElement) => {
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Edit note text" });
  };

  const openExisting = async (id = 5) => {
    render(<Notes />);
    await open(await screen.findByRole("button", { name: /^Edit/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit note text" }));
    return id;
  };

  const openToRead = async () => {
    render(<Notes />);
    await open(await screen.findByRole("button", { name: /^Edit/ }));
  };

  it("opens formatted, and clicking the text edits it in place", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openToRead();
    expect(titleField().value).toBe("Old");
    expect(screen.getByText("Old body")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Start writing…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit note text" }));
    expect(bodyField().value).toBe("Old body");
    expect(document.activeElement).toBe(bodyField());
  });

  it("keeps the count bar while a note is open", async () => {
    setStore([saved(5, "Old", "Old body")]);
    render(<Notes />);
    await screen.findByText("1 total");
    fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
    expect(screen.getByText("1 total")).toBeTruthy();
    expect(screen.getByText("Add new notes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await screen.findByText("1 total");
  });

  describe("the ⋮ menu's Delete", () => {
    const twoNotes = async () => {
      setStore([saved(5, "Old", "Old body"), saved(6, "Other", "Other body")]);
      render(<Notes />);
      await screen.findByText("2 total");
    };
    const deleteFromMenu = (name: string) => {
      fireEvent.click(
        screen.getByRole("button", { name: `More options for ${name}` })
      );
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    };

    it("deletes the note after confirming", async () => {
      await twoNotes();
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      deleteFromMenu("Old");
      await screen.findByText("1 total");
      expect(api.deleteNoteApi).toHaveBeenCalledWith(5);
      expect(screen.queryByRole("button", { name: /^Edit Old/ })).toBeNull();
      expect(screen.getByRole("button", { name: /^Edit Other/ })).toBeTruthy();
      expect(screen.queryByRole("menu")).toBeNull();
      confirmSpy.mockRestore();
    });

    it("keeps the note when the confirm is cancelled", async () => {
      await twoNotes();
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      deleteFromMenu("Old");
      expect(api.deleteNoteApi).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /^Edit Old/ })).toBeTruthy();
      confirmSpy.mockRestore();
    });

    it("keeps the note when the delete fails", async () => {
      await twoNotes();
      api.deleteNoteApi.mockRejectedValue(new Error("offline"));
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      deleteFromMenu("Old");
      await screen.findByText("Couldn't delete. Check your connection.");
      expect(screen.getByRole("button", { name: /^Edit Old/ })).toBeTruthy();
      expect(screen.getByText("2 total")).toBeTruthy();
      confirmSpy.mockRestore();
    });

    it("closes the note if it's the open one", async () => {
      await twoNotes();
      fireEvent.click(screen.getByRole("button", { name: /^Edit Old/ }));
      await screen.findByText("Old body");
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      deleteFromMenu("Old");
      await screen.findByText("1 total");
      expect(screen.queryByPlaceholderText("Enter note title")).toBeNull();
      confirmSpy.mockRestore();
    });
  });

  it("asks before Add new notes discards a typed new note", async () => {
    setStore([]);
    render(<Notes />);
    await screen.findByText("Add new notes");
    fireEvent.click(screen.getByText("Add new notes"));
    fireEvent.change(titleField(), { target: { value: "Draft" } });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByText("Add new notes"));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(titleField().value).toBe("Draft"));
    confirmSpy.mockRestore();
  });

  describe("beside the list", () => {
    const two = [
      saved(5, "First", "First body"),
      saved(6, "Second", "Second body"),
    ];
    const row = (name: string) =>
      screen.getByRole("button", { name: new RegExp(`^Edit ${name}\\.`) });

    it("keeps the names showing and marks the open one", async () => {
      setStore(two);
      render(<Notes />);
      await screen.findByText("Second");
      await open(row("First"));
      expect(titleField().value).toBe("First");
      expect(row("Second")).toBeTruthy();
      expect(row("First").getAttribute("aria-current")).toBe("true");
      expect(row("Second").getAttribute("aria-current")).toBeNull();
    });

    it("switches notes, saving the one left first", async () => {
      setStore(two);
      render(<Notes />);
      await screen.findByText("Second");
      await open(row("First"));
      type(titleField(), "First edited");
      fireEvent.click(row("Second"));
      await waitFor(() => expect(titleField().value).toBe("Second"));
      expect(api.updateNoteApi).toHaveBeenCalledWith(5, {
        title: "First edited",
        content: "First body",
      });
    });

    it("stays on the note if it can't be saved", async () => {
      setStore(two);
      api.updateNoteApi.mockRejectedValue(new Error("down"));
      render(<Notes />);
      await screen.findByText("Second");
      await open(row("First"));
      type(titleField(), "First edited");
      fireEvent.click(row("Second"));
      await screen.findByText("Couldn't save. Check your connection.");
      expect(titleField().value).toBe("First edited");
    });

    it("clicking the open note again keeps its unsaved text", async () => {
      setStore(two);
      render(<Notes />);
      await screen.findByText("Second");
      await open(row("First"));
      type(titleField(), "Still typing");
      fireEvent.click(row("First"));
      expect(titleField().value).toBe("Still typing");
    });
  });

  it("doesn't put the cursor in the title just by opening", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openToRead();
    expect(document.activeElement).not.toBe(titleField());
  });

  it("goes back to formatted when the text loses focus", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openExisting();
    type(bodyField(), "Unsaved");
    fireEvent.blur(bodyField());
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Start writing…")).toBeNull();
  });

  it("has no Save button and saves a title edit by itself", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openToRead();
    type(titleField(), "New title");
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await waitFor(
      () =>
        expect(api.updateNoteApi).toHaveBeenCalledWith(5, {
          title: "New title",
          content: "Old body",
        }),
      { timeout: 2000 }
    );
  });

  it("saves as soon as the text loses focus", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openExisting();
    type(bodyField(), "New body");
    fireEvent.blur(bodyField());
    // Well inside the typing pause, so this can only be the blur.
    await waitFor(() => expect(api.updateNoteApi).toHaveBeenCalledTimes(1), {
      timeout: 200,
    });
    expect(api.updateNoteApi).toHaveBeenCalledWith(5, {
      title: "Old",
      content: "New body",
    });
  });

  it("doesn't send an unchanged note", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openToRead();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await screen.findByText("Add new notes");
    expect(api.updateNoteApi).not.toHaveBeenCalled();
  });

  it("never sends a note emptied of all text", async () => {
    setStore([saved(5, "Old", "")]);
    await openToRead();
    type(titleField(), "");
    fireEvent.blur(titleField());
    expect(api.updateNoteApi).not.toHaveBeenCalled();
  });

  it("saves edits one at a time, in order", async () => {
    setStore([saved(5, "Old", "Old body")]);
    let finishFirst: (row: unknown) => void = () => {};
    api.updateNoteApi.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      })
    );
    await openExisting();
    type(bodyField(), "First");
    fireEvent.blur(titleField());
    type(titleField(), "Second title");
    fireEvent.blur(titleField());
    await waitFor(() => expect(api.updateNoteApi).toHaveBeenCalledTimes(1));
    // The second must wait for the first, however long that takes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.updateNoteApi).toHaveBeenCalledTimes(1);
    finishFirst(saved(5, "Old", "First"));
    await waitFor(() => expect(api.updateNoteApi).toHaveBeenCalledTimes(2));
    expect(api.updateNoteApi.mock.calls[1][1]).toEqual({
      title: "Second title",
      content: "First",
    });
  });

  it("Close waits for the save, and stays open if it fails", async () => {
    setStore([saved(5, "Old", "Old body")]);
    api.updateNoteApi.mockRejectedValue(new Error("down"));
    await openExisting();
    type(bodyField(), "Precious");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await screen.findByText("Not saved, retrying…");
    expect(bodyField().value).toBe("Precious");
    expect(sessionStorage.getItem(KEY)).not.toBeNull();
  });

  it("Close saves pending changes before leaving", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openExisting();
    type(bodyField(), "Last words");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await screen.findByText("Add new notes");
    expect(api.updateNoteApi).toHaveBeenCalledWith(5, {
      title: "Old",
      content: "Last words",
    });
  });

  it("Close from reading returns to the list", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openToRead();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await screen.findByText("Add new notes");
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("is still being read after leaving and coming back", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openToRead();
    await leaveAndReturn();
    await screen.findByText("Old body");
    expect(screen.queryByPlaceholderText("Start writing…")).toBeNull();
  });

  it("saves the last edit when leaving the page", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openExisting();
    type(bodyField(), "Typed just before leaving");
    await leaveAndReturn();
    expect(api.updateNoteApi).toHaveBeenCalledWith(5, {
      title: "Old",
      content: "Typed just before leaving",
    });
  });

  it("shows the server's copy after a successful save, not the draft", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openExisting();
    type(bodyField(), "Mine");
    await waitFor(() => expect(api.updateNoteApi).toHaveBeenCalled(), {
      timeout: 2000,
    });
    await waitFor(() => expect(readOpenNote(1)?.edited).toBe(false));
    setStore([saved(5, "Old", "Changed elsewhere")]);
    await leaveAndReturn();
    await waitFor(() => expect(bodyField().value).toBe("Changed elsewhere"));
  });

  it("keeps an edit that couldn't be saved over a newer copy", async () => {
    setStore([saved(5, "Old", "Old body")]);
    api.updateNoteApi.mockRejectedValue(new Error("down"));
    await openExisting();
    type(bodyField(), "My edit");
    setStore([saved(5, "Old", "Changed elsewhere")]);
    await leaveAndReturn();
    await waitFor(() => expect(readOpenNote(1)?.edited).toBe(true));
    expect(bodyField().value).toBe("My edit");
  });

  it("shows the newer saved copy when nothing was edited", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openExisting();
    expect(readOpenNote(1)?.edited).toBe(false);
    setStore([saved(5, "Newer", "Changed elsewhere")]);
    await leaveAndReturn();
    await waitFor(() => expect(bodyField().value).toBe("Changed elsewhere"));
    expect(titleField().value).toBe("Newer");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull()
    );
  });

  it("doesn't overwrite what's typed while the saved copy is still loading", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openExisting();
    cleanup();
    let finish: (row: Saved) => void = () => {};
    api.getNote.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    render(<Notes />);
    type(bodyField(), "Typed fast");
    await waitFor(() => expect(api.getNote).toHaveBeenCalledTimes(2));
    finish(saved(5, "Old", "Changed elsewhere"));
    await waitFor(
      () =>
        expect(api.updateNoteApi).toHaveBeenCalledWith(5, {
          title: "Old",
          content: "Typed fast",
        }),
      { timeout: 2000 }
    );
    expect(bodyField().value).toBe("Typed fast");
  });

  it("turns edits into a new note if it was deleted elsewhere", async () => {
    setStore([saved(5, "Old", "Old body")]);
    api.updateNoteApi.mockRejectedValue(new Error("not found"));
    await openExisting();
    type(bodyField(), "Don't lose me");
    setStore([]);
    await leaveAndReturn();
    const create = await screen.findByRole("button", { name: "Create note" });
    expect(bodyField().value).toBe("Don't lose me");
    fireEvent.click(create);
    await waitFor(() => expect(api.createNoteApi).toHaveBeenCalled());
  });

  it("closes if it was deleted elsewhere with nothing edited", async () => {
    setStore([saved(5, "Old", "Old body")]);
    await openExisting();
    setStore([]);
    await leaveAndReturn();
    await screen.findByText("Add new notes");
    expect(screen.queryByPlaceholderText("Enter note title")).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe("the saved entry", () => {
  it("isn't restored for another user", async () => {
    await startNewNote();
    type(titleField(), "Private");
    cleanup();
    auth.user = { id: 2 };
    render(<Notes />);
    await screen.findByText("Add new notes");
    expect(screen.queryByDisplayValue("Private")).toBeNull();
  });

  it("is removed by forgetOpenNote, as logout does", async () => {
    await startNewNote();
    type(titleField(), "Private");
    forgetOpenNote();
    expect(readOpenNote(1)).toBeNull();
  });

  it.each([
    ["not JSON", "{oops"],
    ["null", "null"],
    ["a wrong type", JSON.stringify({ userId: 1, noteId: "x", title: 1 })],
    ["no text", JSON.stringify({ userId: 1, noteId: "new" })],
  ])("is ignored when it's %s", async (_name, value) => {
    sessionStorage.setItem(KEY, value);
    render(<Notes />);
    await screen.findByText("Add new notes");
  });
});
