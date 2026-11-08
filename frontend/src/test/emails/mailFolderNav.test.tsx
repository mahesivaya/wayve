// The email sidebar's folder + label menu: Gmail-style folders with badge
// counts, a "More" section, and the mailboxes' labels nested by "/".
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MailFolderNav from "../../emails/MailFolderNav";
import { buildLabelTree } from "../../emails/labelTree";

const getEmailSidebar = vi.fn();
vi.mock("../../api/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/email")>()),
  getEmailSidebar: (...args: unknown[]) => getEmailSidebar(...args),
}));

const label = (label_id: string, name: string, unread = 0, account_id = 4) => ({
  account_id,
  account_email: `box${account_id}@x.test`,
  label_id,
  name,
  color: null,
  unread,
});

beforeEach(() => {
  localStorage.clear();
  getEmailSidebar.mockReset().mockResolvedValue({
    counts: { inbox: 792, drafts: 1, spam: 12, promotions: 1105 },
    labels: [
      label("Label_1", "[Superhuman]"),
      label("Label_2", "[Superhuman]/AI"),
      label("Label_3", "[Superhuman]/AI/Marketing", 14),
      label("Label_4", "[Superhuman]/AI/Meeting"),
    ],
  });
});

describe("buildLabelTree", () => {
  it("nests by '/' and keeps a parent that isn't itself a label", () => {
    const tree = buildLabelTree([
      label("Label_9", "Work/Clients/Acme"),
      label("Label_8", "Work/Admin"),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].segment).toBe("Work");
    expect(tree[0].label).toBeNull();
    expect(tree[0].children.map((c) => c.segment)).toEqual([
      "Admin",
      "Clients",
    ]);
    expect(tree[0].children[1].children[0].label?.label_id).toBe("Label_9");
  });
});

describe("MailFolderNav", () => {
  it("shows the folders with Gmail-style counts", async () => {
    render(<MailFolderNav activeFolder="inbox" onSelectFolder={vi.fn()} />);
    const inbox = await screen.findByRole("button", { name: /Inbox\s*792/ });
    expect(inbox.getAttribute("aria-current")).toBe("page");
    expect(
      screen.getByRole("button", { name: /Promotions\s*1,105/ })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Drafts\s*1/ })).toBeTruthy();
    // Trash sits under More until opened.
    expect(screen.queryByRole("button", { name: "Trash" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Trash" })).toBeTruthy();
  });

  it("nests labels and opens one as a folder", async () => {
    const onSelectFolder = vi.fn();
    render(
      <MailFolderNav activeFolder="inbox" onSelectFolder={onSelectFolder} />
    );
    const marketing = await screen.findByRole("button", {
      name: /Marketing\s*14/,
    });
    await userEvent.click(marketing);
    expect(onSelectFolder).toHaveBeenCalledWith("label:4:Label_3");

    // Collapsing "AI" hides its children.
    await userEvent.click(screen.getByRole("button", { name: "Collapse AI" }));
    expect(screen.queryByRole("button", { name: /Marketing/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Expand AI" })).toBeTruthy();
  });

  it("highlights the open label and scopes to the chosen account", async () => {
    render(
      <MailFolderNav
        activeFolder="label:4:Label_4"
        onSelectFolder={vi.fn()}
        accountId={4}
      />
    );
    const labels = (await screen.findByText("Labels"))
      .parentElement as HTMLElement;
    expect(
      within(labels)
        .getByRole("button", { name: "Meeting" })
        .getAttribute("aria-current")
    ).toBe("page");
    expect(getEmailSidebar).toHaveBeenCalledWith(4);
  });
});

// Inside a split pane the menu is a Gmail-style icon rail: no text, unread as
// a dot, and each icon named for hover and screen readers.
describe("MailFolderNav as an icon rail", () => {
  it("draws icons only, with a dot instead of a count", async () => {
    const { container } = render(
      <MailFolderNav activeFolder="inbox" onSelectFolder={vi.fn()} rail />
    );
    const inbox = await screen.findByRole("button", {
      name: "Inbox (792 unread)",
    });
    expect(inbox.getAttribute("title")).toBe("Inbox (792 unread)");
    expect(inbox.querySelector(".mail-nav-dot")).toBeTruthy();
    expect(inbox.textContent).toBe("");

    const starred = screen.getByRole("button", { name: "Starred" });
    expect(starred.querySelector(".mail-nav-dot")).toBeNull();

    expect(container.querySelector(".mail-nav-label")).toBeNull();
    expect(container.querySelector(".mail-nav-count")).toBeNull();
    expect(screen.queryByText("Labels")).toBeNull();
  });

  it("still opens More and selects a label from its icon", async () => {
    const onSelectFolder = vi.fn();
    render(
      <MailFolderNav
        activeFolder="inbox"
        onSelectFolder={onSelectFolder}
        rail
      />
    );
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Trash" })).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", {
        name: "[Superhuman]/AI/Marketing (14 unread)",
      })
    );
    expect(onSelectFolder).toHaveBeenCalledWith("label:4:Label_3");
  });
});

describe("EmailSidebar menu toggle in a split pane", () => {
  it("switches between the icon rail and the full menu", async () => {
    const { EmailSidebar } = await import("../../emails/EmailSidebar");
    const { useState } = await import("react");
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <EmailSidebar
          accounts={[]}
          activeAccount={null}
          setActiveAccount={vi.fn()}
          activeFolder="inbox"
          setActiveFolder={vi.fn()}
          viewMode="email"
          onOpenFiles={vi.fn()}
          onRequestAddAccount={vi.fn()}
          onCompose={vi.fn()}
          composeDisabled={false}
          width={220}
          onRenameAccount={vi.fn()}
          showAccountManagement={false}
          rail={!open}
          onToggleMenu={() => setOpen((o) => !o)}
        />
      );
    }
    const { container } = render(<Harness />);
    expect(container.querySelector(".email-sidebar--rail")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Expand menu" }));
    expect(container.querySelector(".email-sidebar--rail")).toBeNull();
    expect(await screen.findByText("Inbox")).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Collapse menu" })
    );
    expect(container.querySelector(".email-sidebar--rail")).toBeTruthy();
  });
});
