// Organization and platform members read their team mailboxes as one unified
// inbox, so the email sidebar's Accounts block is left out for them. Personal
// users keep it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

let scope = "organization";

vi.mock("../../api/email", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getAccounts: vi.fn().mockResolvedValue([{ id: 7, email: "team@org.test" }]),
  getEmails: vi
    .fn()
    .mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
  wakeEmailSync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "me@org.test", account_type: scope, scope },
    logout: vi.fn(),
  }),
}));
vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => ({
    searchQuery: "",
    normalizedSearchQuery: "",
    setSearchQuery: vi.fn(),
    emailViewLayout: "list",
    setEmailViewLayout: vi.fn(),
  }),
}));
vi.mock("../../search/SearchBar", () => ({ default: () => null }));
vi.mock("../../emails/EmailList", () => ({ EmailList: () => null }));
vi.mock("../../emails/EmailSidebar", () => ({
  EmailSidebar: (props: {
    accounts: unknown[];
    showAccountFilter?: boolean;
    showAccountManagement?: boolean;
  }) => (
    <div
      data-testid="sidebar"
      data-accounts={props.accounts.length}
      data-filter={String(props.showAccountFilter)}
      data-management={String(props.showAccountManagement)}
    />
  ),
}));

import Emails from "../../emails/Emails";

const renderEmails = async () => {
  render(
    <MemoryRouter>
      <Emails />
    </MemoryRouter>
  );
  const sidebar = await screen.findByTestId("sidebar");
  // Wait for the accounts to load, so the filter decision has its inputs.
  await vi.waitFor(() => expect(sidebar.dataset.accounts).toBe("1"));
  return sidebar;
};

describe("the email sidebar's Accounts block", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("is hidden for organization members", async () => {
    scope = "organization";
    const sidebar = await renderEmails();
    expect(sidebar.dataset.filter).toBe("false");
    expect(sidebar.dataset.management).toBe("false");
  });

  it("is hidden for platform members", async () => {
    scope = "platform";
    const sidebar = await renderEmails();
    expect(sidebar.dataset.filter).toBe("false");
    expect(sidebar.dataset.management).toBe("false");
  });

  it("still shows for personal users", async () => {
    scope = "personal";
    const sidebar = await renderEmails();
    expect(sidebar.dataset.filter).toBe("true");
    expect(sidebar.dataset.management).toBe("true");
  });
});
