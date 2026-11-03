// The new message form opens inside the Emails page rather than over the whole
// window, so the other split pane stays usable. Mounts the real page and Modal;
// only the API, the form and the list and sidebar panes are stubbed.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
  getAccounts: vi.fn().mockResolvedValue([{ id: 7, email: "me@test.local" }]),
  getEmails: vi
    .fn()
    .mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
  wakeEmailSync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      email: "me@test.local",
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
vi.mock("../../emails/EmailList", () => ({ EmailList: () => null }));
vi.mock("../../emails/EmailSidebar", () => ({
  EmailSidebar: (props: { onCompose: () => void }) => (
    <button onClick={props.onCompose}>New message</button>
  ),
}));
vi.mock("../../emails/SendEmail", () => ({
  default: () => <input aria-label="message form" />,
}));

import Emails from "../../emails/Emails";

const openForm = async () => {
  render(
    <MemoryRouter>
      <Emails />
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByText("New message"));
  // The form renders once the accounts have arrived.
  return screen.findByLabelText("message form");
};

describe("the new message form", () => {
  it("opens inside the Emails page and leaves the window alone", async () => {
    const form = await openForm();

    const dialog = form.closest<HTMLElement>('[role="dialog"]');
    expect(dialog?.className).toContain("modal-overlay--contained");
    expect(dialog?.closest(".emails-root")).not.toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("closes on Escape pressed inside it", async () => {
    const form = await openForm();

    fireEvent.keyDown(form, { key: "Escape" });

    expect(screen.queryByLabelText("message form")).toBeNull();
  });
});
