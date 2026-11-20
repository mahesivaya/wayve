// The notes list comes from the server a page at a time, without note text.
// Search and sort are asked of the server, and a note's text is fetched when
// it's opened.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  NOTES_PAGE_SIZE: 50,
  getNotes: vi.fn(),
  getNote: vi.fn(),
  createNoteApi: vi.fn(),
  updateNoteApi: vi.fn(),
  deleteNoteApi: vi.fn(),
}));
const search = vi.hoisted(() => ({ normalizedSearchQuery: "" }));

vi.mock("../../api/notes", () => api);
vi.mock("../../auth/useAuth", () => ({ useAuth: () => ({ user: { id: 1 } }) }));
vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => search,
}));
vi.mock("../../crypto/selfEncrypt", () => ({
  decryptForSelf: (text: string) => Promise.resolve(text),
}));

import Notes from "../../notes/Notes";

const summary = (id: number, title: string) => ({
  id,
  title,
  created_at: "2026-11-01T10:00:00Z",
  updated_at: `2026-11-01T12:${String(60 - id).padStart(2, "0")}:00Z`,
});
const page = (
  rows: ReturnType<typeof summary>[],
  total: number,
  hasMore: boolean
) => ({ notes: rows, total, has_more: hasMore });

const row = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^Edit ${name}\\.`) });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  search.normalizedSearchQuery = "";
  api.getNotes.mockResolvedValue(page([], 0, false));
  api.getNote.mockResolvedValue(null);
  api.updateNoteApi.mockResolvedValue(summary(1, "t"));
});

describe("the list", () => {
  it("asks for the first page newest edit first and counts every note", async () => {
    api.getNotes.mockResolvedValue(page([summary(1, "One")], 120, true));
    render(<Notes />);
    await screen.findByText("120 total");
    expect(api.getNotes).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      sort: "edited",
      dir: "desc",
      q: undefined,
    });
  });

  it("loads the next page after the rows it has", async () => {
    api.getNotes.mockResolvedValueOnce(
      page([summary(1, "One"), summary(2, "Two")], 3, true)
    );
    render(<Notes />);
    await screen.findByText("Two");
    api.getNotes.mockResolvedValueOnce(page([summary(3, "Three")], 3, false));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await screen.findByText("Three");
    expect(api.getNotes).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 2 })
    );
    expect(screen.getByText("One")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("asks the server to sort when a column is picked", async () => {
    api.getNotes.mockResolvedValue(page([summary(1, "One")], 1, false));
    render(<Notes />);
    await screen.findByText("One");
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    await waitFor(() =>
      expect(api.getNotes).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: "name", dir: "asc", offset: 0 })
      )
    );
  });

  it("searches on the server", async () => {
    search.normalizedSearchQuery = "egg";
    render(<Notes />);
    await screen.findByText("No matching notes");
    // After a pause in typing, not on every key.
    expect(api.getNotes).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(api.getNotes).toHaveBeenCalledWith(
        expect.objectContaining({ q: "egg", offset: 0 })
      )
    );
  });
});

describe("opening a note", () => {
  it("fetches its text, and saves nothing until it's there", async () => {
    api.getNotes.mockResolvedValue(page([summary(1, "One")], 1, false));
    let finish: (note: unknown) => void = () => {};
    api.getNote.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    render(<Notes />);
    await screen.findByText("One");
    fireEvent.click(row("One"));
    expect(api.getNote).toHaveBeenCalledWith(1);
    expect(screen.getByText("Loading…")).toBeTruthy();
    const title = screen.getByPlaceholderText(
      "Enter note title"
    ) as HTMLInputElement;
    expect(title.readOnly).toBe(true);
    finish({ ...summary(1, "One"), content: "The body" });
    await screen.findByText("The body");
    expect(title.readOnly).toBe(false);
    expect(api.updateNoteApi).not.toHaveBeenCalled();
  });

  it("drops a note that was deleted elsewhere", async () => {
    api.getNotes.mockResolvedValue(
      page([summary(1, "Gone"), summary(2, "Here")], 2, false)
    );
    render(<Notes />);
    await screen.findByText("Gone");
    fireEvent.click(row("Gone"));
    await screen.findByText("That note was deleted.");
    expect(screen.queryByText("Gone")).toBeNull();
    expect(screen.getByText("1 total")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Enter note title")).toBeNull();
  });
});
