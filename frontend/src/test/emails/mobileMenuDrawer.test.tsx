// Phones hide the folder chips; a ☰ before select-all opens the folder menu
// as a drawer, which closes on a pick, on ☰ inside it, or on the backdrop.
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
  getAccounts: vi.fn().mockResolvedValue([{ id: 7, email: "me@x.test" }]),
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
      account_type: "personal",
      scope: "personal",
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
vi.mock("../../emails/SendEmail", () => ({ default: () => null }));
// The list's own ☰ is covered below; here it only needs to call onOpenMenu.
vi.mock("../../emails/EmailList", () => ({
  EmailList: (props: { onOpenMenu?: () => void }) => (
    <button onClick={props.onOpenMenu}>Open folders menu</button>
  ),
}));

import Emails from "../../emails/Emails";

const drawer = () => document.querySelector(".email-sidebar--drawer");
const backdrop = () => document.querySelector(".email-drawer-backdrop");

const renderEmails = () =>
  render(
    <MemoryRouter>
      <Emails />
    </MemoryRouter>
  );

describe("the phone folder menu drawer", () => {
  it("opens from ☰ and closes after a folder is picked", async () => {
    const user = userEvent.setup();
    renderEmails();
    expect(drawer()).toBeNull();

    await user.click(await screen.findByText("Open folders menu"));
    expect(drawer()).not.toBeNull();
    expect(backdrop()).not.toBeNull();

    await user.click(await screen.findByRole("button", { name: /^Sent/ }));
    await waitFor(() => expect(drawer()).toBeNull());
    expect(backdrop()).toBeNull();
  });

  it("closes on the backdrop and on ☰ inside it", async () => {
    const user = userEvent.setup();
    renderEmails();

    await user.click(await screen.findByText("Open folders menu"));
    await user.click(backdrop() as Element);
    expect(drawer()).toBeNull();

    await user.click(screen.getByText("Open folders menu"));
    await user.click(screen.getByRole("button", { name: "Collapse menu" }));
    expect(drawer()).toBeNull();
  });
});

describe("EmailList's ☰ button", () => {
  it("sits before the select-all checkbox when onOpenMenu is given", async () => {
    // The module is mocked above; reach the real one for this check.
    const { EmailList } = await vi.importActual<
      typeof import("../../emails/EmailList")
    >("../../emails/EmailList");
    const onOpenMenu = vi.fn();
    render(
      <EmailList
        emails={[
          {
            id: 1,
            subject: "Hi",
            sender: "a@x.test",
            created_at: "2026-11-08T10:00:00Z",
          },
        ]}
        selectedEmailId={null}
        onOpenEmail={() => {}}
        hasMore={false}
        loadMore={vi.fn()}
        loadingMore={false}
        activeFolder="inbox"
        isListView
        scrollKey="menu-btn"
        onOpenMenu={onOpenMenu}
      />
    );
    const menu = screen.getByRole("button", { name: "Open folders menu" });
    const master = document.querySelector(".email-bulk-master");
    expect(
      menu.compareDocumentPosition(master as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    await userEvent.click(menu);
    expect(onOpenMenu).toHaveBeenCalled();
  });
});
