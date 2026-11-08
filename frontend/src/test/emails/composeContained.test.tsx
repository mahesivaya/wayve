// The new message form opens as a Gmail-style docked window inside the Emails
// page, with no backdrop, so the emails behind it (and the other split pane)
// stay usable. Mounts the real page and compose window;
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
  it("opens as a docked window inside the Emails page, with no backdrop", async () => {
    const form = await openForm();

    const win = form.closest<HTMLElement>('[role="dialog"]');
    expect(win?.className).toContain("compose-window");
    expect(win?.getAttribute("aria-modal")).toBe("false");
    expect(win?.closest(".emails-root")).not.toBeNull();
    // Nothing covers the page, so the emails behind it stay usable.
    expect(document.querySelector(".modal-overlay")).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("keeps the emails behind it usable while open", async () => {
    await openForm();

    // The sidebar stub's button is still reachable and clickable.
    fireEvent.click(screen.getByText("New message"));
    expect(screen.getByLabelText("message form")).toBeTruthy();
  });

  it("minimizes to its title bar without losing the draft", async () => {
    const form = await openForm();
    fireEvent.change(form, { target: { value: "half-written" } });

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    const body = form.closest<HTMLElement>(".compose-window-body");
    expect(body?.hidden).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(body?.hidden).toBe(false);
    expect(
      (screen.getByLabelText("message form") as HTMLInputElement).value
    ).toBe("half-written");
  });

  it("expands to full screen and back", async () => {
    const form = await openForm();
    const win = form.closest<HTMLElement>(".compose-window");

    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(win?.className).toContain("is-maximized");
    fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
    expect(win?.className).not.toContain("is-maximized");
  });

  it("closes from its close button", async () => {
    await openForm();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByLabelText("message form")).toBeNull();
  });

  it("closes on Escape pressed inside it", async () => {
    const form = await openForm();

    fireEvent.keyDown(form, { key: "Escape" });

    expect(screen.queryByLabelText("message form")).toBeNull();
  });
});
