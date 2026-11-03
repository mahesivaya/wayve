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
  getNotes: vi.fn(),
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
  api.getNotes.mockResolvedValue([]);
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
  const openExisting = async (id = 5) => {
    render(<Notes />);
    fireEvent.click(await screen.findByRole("button", { name: /^Edit/ }));
    return id;
  };

  it("keeps unsaved edits, saved back to the same note", async () => {
    api.getNotes.mockResolvedValue([saved(5, "Old", "Old body")]);
    await openExisting();
    type(bodyField(), "New body");
    await leaveAndReturn();
    expect(bodyField().value).toBe("New body");
    await screen.findByRole("button", { name: "Save changes" });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(api.updateNoteApi).toHaveBeenCalledWith(5, {
        title: "Old",
        content: "New body",
      })
    );
  });

  it("keeps edits over a newer saved copy", async () => {
    api.getNotes.mockResolvedValue([saved(5, "Old", "Old body")]);
    await openExisting();
    type(bodyField(), "My edit");
    api.getNotes.mockResolvedValue([saved(5, "Old", "Changed elsewhere")]);
    await leaveAndReturn();
    await waitFor(() => expect(readOpenNote(1)?.edited).toBe(true));
    expect(bodyField().value).toBe("My edit");
  });

  it("shows the newer saved copy when nothing was edited", async () => {
    api.getNotes.mockResolvedValue([saved(5, "Old", "Old body")]);
    await openExisting();
    expect(readOpenNote(1)?.edited).toBe(false);
    api.getNotes.mockResolvedValue([saved(5, "Newer", "Changed elsewhere")]);
    await leaveAndReturn();
    await waitFor(() => expect(bodyField().value).toBe("Changed elsewhere"));
    expect(titleField().value).toBe("Newer");
    const save = screen.getByRole("button", {
      name: "Save changes",
    }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(true));
  });

  it("doesn't overwrite what's typed while the list is still loading", async () => {
    api.getNotes.mockResolvedValue([saved(5, "Old", "Old body")]);
    await openExisting();
    cleanup();
    let finish: (rows: unknown[]) => void = () => {};
    api.getNotes.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    render(<Notes />);
    type(bodyField(), "Typed fast");
    await waitFor(() => expect(api.getNotes).toHaveBeenCalledTimes(2));
    finish([saved(5, "Old", "Changed elsewhere")]);
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Save changes",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    expect(bodyField().value).toBe("Typed fast");
  });

  it("turns edits into a new note if it was deleted elsewhere", async () => {
    api.getNotes.mockResolvedValue([saved(5, "Old", "Old body")]);
    await openExisting();
    type(bodyField(), "Don't lose me");
    api.getNotes.mockResolvedValue([]);
    await leaveAndReturn();
    const create = await screen.findByRole("button", { name: "Create note" });
    expect(bodyField().value).toBe("Don't lose me");
    fireEvent.click(create);
    await waitFor(() => expect(api.createNoteApi).toHaveBeenCalled());
    expect(api.updateNoteApi).not.toHaveBeenCalled();
  });

  it("closes if it was deleted elsewhere with nothing edited", async () => {
    api.getNotes.mockResolvedValue([saved(5, "Old", "Old body")]);
    await openExisting();
    api.getNotes.mockResolvedValue([]);
    await leaveAndReturn();
    await screen.findByText("Add new notes");
    expect(screen.queryByPlaceholderText("Enter note title")).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("is forgotten after deleting it", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.getNotes.mockResolvedValue([saved(5, "Old", "Old body")]);
    await openExisting();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteNoteApi).toHaveBeenCalledWith(5));
    await screen.findByText("Add new notes");
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
