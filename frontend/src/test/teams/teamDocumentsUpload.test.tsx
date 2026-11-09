// Team Documents has Drive's Upload button: it uploads into the folder being
// viewed, in that team's own tree, and is only for admins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listDocumentFolders = vi.fn();
const listDocuments = vi.fn();
const uploadDocuments = vi.fn();
let currentUser: Record<string, unknown> = {};

vi.mock("../../api/documents", () => ({
  listDocumentFolders: (...a: unknown[]) => listDocumentFolders(...a),
  listDocuments: (...a: unknown[]) => listDocuments(...a),
  uploadDocuments: (...a: unknown[]) => uploadDocuments(...a),
  createDocumentFolder: vi.fn(),
  renameDocumentFolder: vi.fn(),
  deleteDocumentFolder: vi.fn(),
  renameDocument: vi.fn(),
  deleteDocument: vi.fn(),
  downloadDocument: vi.fn(),
  createTextDocument: vi.fn(),
  getDocumentContent: vi.fn(),
  updateDocumentContent: vi.fn(),
}));
vi.mock("../../api/ai", () => ({ sendAiChat: vi.fn() }));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: currentUser }),
}));
vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({ normalizedSearchQuery: "" }),
}));

import DocumentsBox from "../../documents/DocumentsBox";

const ADMIN = {
  id: 1,
  scope: "organization",
  effective_role: "admin",
  permissions: ["org:settings"],
};
const file = new File(["hello"], "plan.txt", { type: "text/plain" });
const uploadInput = () => screen.findByLabelText(/Upload/);

describe("team documents upload", () => {
  beforeEach(() => {
    currentUser = ADMIN;
    listDocumentFolders.mockReset();
    listDocumentFolders.mockResolvedValue([
      { id: 77, name: "Specs", parent_folder_id: null, created_at: "" },
    ]);
    listDocuments.mockReset();
    listDocuments.mockResolvedValue([]);
    uploadDocuments.mockReset();
    uploadDocuments.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("uploads to the team's top level", async () => {
    render(<DocumentsBox teamId={5} />);
    await userEvent.upload(await uploadInput(), file);
    expect(uploadDocuments).toHaveBeenCalledWith([file], null, 5);
  });

  it("uploads into the folder being viewed", async () => {
    render(<DocumentsBox teamId={5} />);
    await userEvent.click(await screen.findByText("Specs"));
    await userEvent.upload(await uploadInput(), file);
    expect(uploadDocuments).toHaveBeenCalledWith([file], 77, 5);
  });

  it("gives non-admins no upload, and says who can", async () => {
    currentUser = { ...ADMIN, permissions: [] };
    render(<DocumentsBox teamId={5} />);
    expect(
      await screen.findByText(/Only admins can add or change them/)
    ).toBeTruthy();
    expect(screen.queryByLabelText(/Upload/)).toBeNull();
  });

  it("leaves the org library's toolbar as it was", async () => {
    currentUser = { ...ADMIN, permissions: ["documents:manage"] };
    render(<DocumentsBox />);
    await screen.findByText("Specs");
    expect(screen.queryByLabelText(/Upload/)).toBeNull();
  });
});
