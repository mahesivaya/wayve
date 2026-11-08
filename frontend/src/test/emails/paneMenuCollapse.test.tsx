// In a split pane the email menu is an icon rail; ☰ expands it, and picking a
// folder (or Compose) from the expanded menu folds it back into the rail.
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

vi.mock("../../api/email", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getAccounts: vi.fn().mockResolvedValue([{ id: 7, email: "team@x.test" }]),
  getEmails: vi
    .fn()
    .mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
  getEmailSidebar: vi.fn().mockResolvedValue({ counts: {}, labels: [] }),
  wakeEmailSync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      email: "me@x.test",
      account_type: "platform",
      scope: "platform",
    },
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
vi.mock("../../emails/SendEmail", () => ({ default: () => null }));

import Emails from "../../emails/Emails";
import { SplitPaneContext } from "../../components/SplitPaneContext";

const renderPane = () =>
  render(
    <MemoryRouter>
      <SplitPaneContext.Provider value={true}>
        <Emails />
      </SplitPaneContext.Provider>
    </MemoryRouter>
  );

const rail = () => document.querySelector(".email-sidebar--rail");

describe("the email menu in a split pane", () => {
  it("folds back into the rail after a folder is picked", async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(
      await screen.findByRole("button", { name: "Expand menu" })
    );
    expect(rail()).toBeNull();

    await user.click(await screen.findByRole("button", { name: "Starred" }));
    await waitFor(() => expect(rail()).not.toBeNull());
  });

  it("folds back into the rail after Compose", async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(
      await screen.findByRole("button", { name: "Expand menu" })
    );
    await user.click(
      await screen.findByRole("button", { name: /New message/ })
    );
    await waitFor(() => expect(rail()).not.toBeNull());
  });

  it("folds back into the rail on a click outside it, but not inside", async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(
      await screen.findByRole("button", { name: "Expand menu" })
    );
    // Opening More is a click inside the menu: it stays expanded.
    await user.click(await screen.findByRole("button", { name: "More" }));
    expect(rail()).toBeNull();

    await user.click(document.body);
    await waitFor(() => expect(rail()).not.toBeNull());
  });
});
