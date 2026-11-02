// An open email survives leaving the page. Every route change unmounts Emails and
// the sidebar's /emails link carries no `?open=`, so coming back from Chat used
// to land on the list (or, in split view, on the first email). Drives the real
// page and inbox hook; only the API and the list and detail panes are stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { SplitPaneContext } from "../../components/SplitPaneContext";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const h = vi.hoisted(() => ({
  layout: "list" as "list" | "split",
  setLayout: vi.fn(),
  listDelay: 0,
  listFails: false,
  emailDelay: 0,
  missing: new Set<number>(),
  userId: 1,
}));

const row = (id: number) => ({
  id,
  account_id: 7,
  subject: `subject ${id}`,
  sender: "a@test.local",
  is_read: true,
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const api = vi.hoisted(() => ({
  getEmails: vi.fn(),
  getEmail: vi.fn(),
}));

vi.mock("../../api/email", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getAccounts: vi.fn().mockResolvedValue([{ id: 7, email: "me@test.local" }]),
  getEmails: api.getEmails,
  getEmail: api.getEmail,
  getEmailBody: vi.fn(async (id: number) => ({ ...row(id), body: "body" })),
  markEmailRead: vi.fn().mockResolvedValue(undefined),
  wakeEmailSync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: h.userId,
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
    emailViewLayout: h.layout,
    setEmailViewLayout: h.setLayout,
  }),
}));
vi.mock("../../search/SearchBar", () => ({ default: () => null }));
vi.mock("../../emails/SendEmail", () => ({ default: () => null }));
vi.mock("../../emails/EmailSidebar", () => ({ EmailSidebar: () => null }));
vi.mock("../../emails/EmailList", () => ({
  EmailList: (props: {
    emails: { id: number }[];
    onOpenEmail: (email: unknown) => void;
  }) => (
    <div data-testid="list">
      {props.emails.map((email) => (
        <button key={email.id} onClick={() => props.onOpenEmail(email)}>
          row {email.id}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../emails/EmailDetail", () => ({
  EmailDetail: (props: {
    selectedEmail: { id: number } | null;
    onBack: () => void;
  }) => (
    <div data-testid="detail">
      {props.selectedEmail ? `open ${props.selectedEmail.id}` : "empty"}
      <button onClick={props.onBack}>close email</button>
    </div>
  ),
}));

import Emails from "../../emails/Emails";

const Chrome = () => {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  return (
    <>
      <Link to="/chat">to chat</Link>
      <Link to="/emails">to inbox</Link>
      <button onClick={() => navigate(-1)}>browser back</button>
      <span data-testid="url">{pathname + search}</span>
    </>
  );
};

const renderApp = (path = "/emails") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Chrome />
      <Routes>
        <Route path="/emails" element={<Emails />} />
        <Route path="/chat" element={<div>chat page</div>} />
      </Routes>
    </MemoryRouter>
  );

const detail = () => screen.queryByTestId("detail")?.textContent ?? null;
const url = () => screen.getByTestId("url").textContent;
const expectOpen = (id: number) =>
  waitFor(() => expect(detail()).toContain(`open ${id}`));

const openThenLeave = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByText("row 3"));
  await expectOpen(3);
  await user.click(screen.getByText("to chat"));
  await screen.findByText("chat page");
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  Object.assign(h, {
    layout: "list",
    listDelay: 0,
    listFails: false,
    emailDelay: 0,
    userId: 1,
  });
  h.missing.clear();
  h.setLayout.mockClear();
  api.getEmails.mockReset();
  api.getEmails.mockImplementation(async () => {
    await wait(h.listDelay);
    if (h.listFails) throw new Error("list down");
    return { emails: [row(1), row(2), row(3)], hasMore: false, total: 3 };
  });
  api.getEmail.mockReset();
  api.getEmail.mockImplementation(async (id: number) => {
    await wait(h.emailDelay);
    if (h.missing.has(id)) throw new Error("404");
    return { ...row(id), body: "body" };
  });
});

describe("keeping an email open across pages", () => {
  it("reopens it from the sidebar in list view", async () => {
    const user = userEvent.setup();
    renderApp();
    await openThenLeave(user);

    await user.click(screen.getByText("to inbox"));

    await expectOpen(3);
    expect(url()).toBe("/emails?open=3");
    expect(screen.queryByTestId("list")).toBeNull();
  });

  it("reopens the same email in split view, not the first row", async () => {
    h.layout = "split";
    const user = userEvent.setup();
    renderApp();
    await openThenLeave(user);

    await user.click(screen.getByText("to inbox"));

    await expectOpen(3);
    expect(url()).toBe("/emails?open=3");
    // Coming back must not flip the user's layout to list.
    expect(h.setLayout).not.toHaveBeenCalled();
  });

  it("reopens it on browser Back", async () => {
    const user = userEvent.setup();
    renderApp();
    await openThenLeave(user);

    await user.click(screen.getByText("browser back"));

    await expectOpen(3);
  });

  it.each([
    { name: "the list loads first", listDelay: 5, emailDelay: 40 },
    { name: "the email loads first", listDelay: 40, emailDelay: 5 },
  ])("opens a ?open= link when $name", async ({ listDelay, emailDelay }) => {
    Object.assign(h, { listDelay, emailDelay });
    renderApp("/emails?open=99");

    await expectOpen(99);
    await act(() => wait(80));
    expect(detail()).toContain("open 99");
  });

  it("restores the folder and mailbox it was opened from", async () => {
    sessionStorage.setItem(
      "rwayve.emails.open",
      JSON.stringify({ userId: 1, emailId: 3, account: 7, folder: "sent" })
    );
    renderApp();

    await expectOpen(3);
    expect(api.getEmails.mock.calls[0][0]).toMatchObject({
      folder: "sent",
      accountId: 7,
    });
    // Accounts arriving must not reset the mailbox, or the list would reload.
    await act(() => wait(30));
    expect(
      api.getEmails.mock.calls.every(([args]) => args.accountId === 7)
    ).toBe(true);
  });

  it("does not show the list while the email reopens", async () => {
    const user = userEvent.setup();
    renderApp();
    await openThenLeave(user);
    h.listDelay = 30;

    await user.click(screen.getByText("to inbox"));

    expect(screen.queryByTestId("list")).toBeNull();
    await expectOpen(3);
  });

  it("starts on the list after the email is closed on purpose", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByText("row 3"));
    await expectOpen(3);
    await user.click(screen.getByText("close email"));
    await waitFor(() => expect(url()).toBe("/emails"));

    await user.click(screen.getByText("to chat"));
    await screen.findByText("chat page");
    await user.click(screen.getByText("to inbox"));

    expect(await screen.findByText("row 1")).toBeTruthy();
    expect(detail()).toBeNull();
    expect(url()).toBe("/emails");
  });

  it("closes the email when Inbox is clicked while reading it", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByText("row 3"));
    await expectOpen(3);

    await user.click(screen.getByText("to inbox"));

    expect(await screen.findByText("row 1")).toBeTruthy();
    expect(sessionStorage.getItem("rwayve.emails.open")).toBeNull();
  });

  it("lets an explicit ?open= win over the remembered email", async () => {
    const user = userEvent.setup();
    const view = renderApp();
    await openThenLeave(user);
    view.unmount();

    renderApp("/emails?open=2");

    await expectOpen(2);
    expect(url()).toBe("/emails?open=2");
  });

  it("falls back to the list when the remembered email is gone", async () => {
    sessionStorage.setItem(
      "rwayve.emails.open",
      JSON.stringify({ userId: 1, emailId: 99, account: null, folder: "inbox" })
    );
    h.missing.add(99);
    renderApp();

    expect(await screen.findByText("row 1")).toBeTruthy();
    await waitFor(() =>
      expect(sessionStorage.getItem("rwayve.emails.open")).toBeNull()
    );
    expect(url()).toBe("/emails");
  });

  it("still reopens the email when the list fails to load", async () => {
    sessionStorage.setItem(
      "rwayve.emails.open",
      JSON.stringify({ userId: 1, emailId: 3, account: null, folder: "inbox" })
    );
    h.listFails = true;
    renderApp();

    await expectOpen(3);
  });

  it("never reopens another user's email", async () => {
    sessionStorage.setItem(
      "rwayve.emails.open",
      JSON.stringify({ userId: 2, emailId: 3, account: null, folder: "inbox" })
    );
    renderApp();

    expect(await screen.findByText("row 1")).toBeTruthy();
    expect(detail()).toBeNull();
    expect(url()).toBe("/emails");
  });

  it("stores ids only, never message content", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByText("row 3"));
    await expectOpen(3);

    expect(
      JSON.parse(sessionStorage.getItem("rwayve.emails.open") ?? "{}")
    ).toEqual({ userId: 1, emailId: 3, account: null, folder: "inbox" });
  });
});

describe("an email open in a split pane", () => {
  const renderPane = (path = "/home") =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Chrome />
        <SplitPaneContext.Provider value={true}>
          <Emails />
        </SplitPaneContext.Provider>
      </MemoryRouter>
    );

  it("stays open when the routed pane navigates, and leaves its URL alone", async () => {
    const user = userEvent.setup();
    renderPane();
    await user.click(await screen.findByText("row 3"));
    await expectOpen(3);
    expect(url()).toBe("/home");

    await user.click(screen.getByText("to chat"));
    await act(() => wait(20));

    expect(url()).toBe("/chat");
    expect(detail()).toContain("open 3");
  });

  it("reopens when the pane is mounted again", async () => {
    const user = userEvent.setup();
    const view = renderPane();
    await user.click(await screen.findByText("row 3"));
    await expectOpen(3);
    view.unmount();

    renderPane();

    await expectOpen(3);
    expect(url()).toBe("/home");
  });
});
