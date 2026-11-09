// A team's files use the Documents endpoints with ?team=<id>; without a team the
// requests are exactly the org library's.
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
const apiFetchJson = vi.fn();
vi.mock("../../api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiFetchJson: (...args: unknown[]) => apiFetchJson(...args),
}));

import {
  createDocumentFolder,
  deleteDocument,
  listDocumentFolders,
  listDocuments,
} from "../../api/documents";

describe("team documents requests", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    apiFetchJson.mockReset();
  });

  it("adds the team to a request with no other parameters", async () => {
    await listDocuments(null, 5);
    expect(apiFetchJson.mock.calls[0][0]).toBe("/api/documents?team=5");
  });

  it("adds the team after existing parameters", async () => {
    await listDocumentFolders(3, 5);
    expect(apiFetchJson.mock.calls[0][0]).toBe(
      "/api/document-folders?parent_folder_id=3&team=5"
    );
  });

  it("scopes writes to the team", async () => {
    await createDocumentFolder("Specs", null, 5);
    await deleteDocument(9, 5);
    expect(apiFetch.mock.calls[0][0]).toBe("/api/document-folders?team=5");
    expect(apiFetch.mock.calls[1][0]).toBe("/api/documents/9?team=5");
  });

  it("leaves the org library's requests unchanged", async () => {
    await listDocuments();
    await listDocumentFolders(3);
    expect(apiFetchJson.mock.calls[0][0]).toBe("/api/documents");
    expect(apiFetchJson.mock.calls[1][0]).toBe(
      "/api/document-folders?parent_folder_id=3"
    );
  });
});
