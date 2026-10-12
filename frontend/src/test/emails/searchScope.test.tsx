// A search covers all mail, as in Gmail: the Inbox leaves out archived and
// filter-skipped Gmail mail, so searching only the current folder would never
// find it. Spam, drafts and trash, which all mail leaves out, search in place.
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getEmails = vi.fn();

vi.mock("../../api/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/email")>()),
  getAccounts: vi.fn().mockResolvedValue([]),
  getEmails: (params: unknown) => getEmails(params),
}));

import { listFolder } from "../../emails/searchScope";
import { useEmailInbox } from "../../emails/useEmailInbox";

describe("listFolder", () => {
  it("reads all mail while there is a search", () => {
    for (const folder of [
      "inbox",
      "sent",
      "signal",
      "github",
      "all",
    ] as const) {
      expect(listFolder(folder, "jobs")).toBe("all");
    }
  });

  it("reads the folder itself without one", () => {
    expect(listFolder("inbox", "")).toBe("inbox");
    expect(listFolder("inbox", "   ")).toBe("inbox");
    expect(listFolder("sent", "")).toBe("sent");
  });

  it("searches spam, drafts and trash in place", () => {
    expect(listFolder("spam", "jobs")).toBe("spam");
    expect(listFolder("drafts", "jobs")).toBe("drafts");
    expect(listFolder("trash", "jobs")).toBe("trash");
  });
});

describe("the inbox list request", () => {
  afterEach(() => {
    cleanup();
    getEmails.mockReset();
  });

  it("asks for all mail when searching from the Inbox", async () => {
    getEmails.mockResolvedValue({ emails: [], hasMore: false });
    renderHook(() => useEmailInbox(1, "jobs@x.com"));
    await waitFor(() => expect(getEmails).toHaveBeenCalled());
    expect(getEmails.mock.calls[0][0]).toMatchObject({
      folder: "all",
      query: "jobs@x.com",
    });
  });

  it("asks for the Inbox without a search", async () => {
    getEmails.mockResolvedValue({ emails: [], hasMore: false });
    renderHook(() => useEmailInbox(1, ""));
    await waitFor(() => expect(getEmails).toHaveBeenCalled());
    expect(getEmails.mock.calls[0][0]).toMatchObject({ folder: "inbox" });
  });
});
