import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import GmailPanel from "../../integrations/GmailPanel";

vi.mock("../../api/email", () => ({
  getAccounts: vi.fn().mockResolvedValue([]),
  getGmailConnectUrl: vi.fn().mockResolvedValue("https://accounts.google.com/o/oauth2/v2/auth?x=1"),
}));
import { getAccounts, getGmailConnectUrl } from "../../api/email";

const setAccounts = (v: unknown) =>
  (getAccounts as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(v);

const renderPanel = () =>
  render(
    <MemoryRouter>
      <GmailPanel />
    </MemoryRouter>
  );

describe("GmailPanel", () => {
  beforeEach(() => setAccounts([]));
  afterEach(() => vi.clearAllMocks());

  it("shows Not connected + a Connect button when no mailbox is attached", async () => {
    renderPanel();
    expect(
      await screen.findByRole("button", { name: /connect gmail account/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    // No inbox link until a mailbox exists.
    expect(screen.queryByRole("link", { name: /open inbox/i })).not.toBeInTheDocument();
  });

  it("lists the connected mailbox and an Open inbox link when owned", async () => {
    setAccounts([{ id: 1, email: "owner@fluxze.com", is_owner: true }]);
    renderPanel();
    expect(await screen.findByText(/owner@fluxze.com/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open inbox/i })).toHaveAttribute(
      "href",
      "/emails"
    );
  });

  it("does not count shared-only inboxes as connected", async () => {
    setAccounts([{ id: 2, email: "support@fluxze.com", is_owner: false }]);
    renderPanel();
    expect(await screen.findByText(/not connected/i)).toBeInTheDocument();
  });

  it("starts the OAuth redirect on Connect", async () => {
    renderPanel();
    await userEvent.click(
      await screen.findByRole("button", { name: /connect gmail account/i })
    );
    await waitFor(() => expect(getGmailConnectUrl).toHaveBeenCalledTimes(1));
  });
});
