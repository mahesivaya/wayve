// Opening a filed support ticket shows it, and only shows it. The report is the
// record support replies against, so the view must not offer a way to edit it.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const fx = vi.hoisted(() => {
  const TICKET = {
    id: 5,
    user_id: 1,
    user_email: "mahesh@fluxze.com",
    organization_id: null,
    organization_name: null,
    subject: "Login button does nothing",
    description: "Clicked sign in on Safari.\nNothing happened, no error.",
    category: "bug" as const,
    status: "open" as const,
    created_at: "2026-07-22T10:00:00Z",
    updated_at: "2026-07-22T10:00:00Z",
    resolved_at: null,
    attachment_count: 1,
  };
  const ATTACHMENTS = [
    {
      id: 9,
      ticket_id: 5,
      name: "screenshot.png",
      file_type: "image/png",
      size: 20480,
      created_at: "2026-07-22T10:00:00Z",
    },
  ];
  return { TICKET, ATTACHMENTS };
});

vi.mock("../../api/support", () => ({
  getTicket: vi.fn().mockResolvedValue(fx.TICKET),
  listTicketAttachments: vi.fn().mockResolvedValue(fx.ATTACHMENTS),
  downloadTicketAttachment: vi.fn(),
}));

import SupportTicketView from "../../support/SupportTicketView";

describe("support ticket view", () => {
  it("shows the filed report", async () => {
    render(<SupportTicketView ticketId={5} onClose={() => {}} />);

    expect(await screen.findByText("Login button does nothing")).toBeTruthy();
    // The description keeps its own line breaks, so it is matched loosely.
    expect(screen.getByText(/Clicked sign in on Safari/)).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("bug")).toBeTruthy();
    expect(screen.getByText("screenshot.png")).toBeTruthy();
  });

  it("offers nothing to edit", async () => {
    const { container } = render(
      <SupportTicketView ticketId={5} onClose={() => {}} />
    );
    await screen.findByText("Login button does nothing");

    // No field of any kind: this is what "read-only" has to mean, and it is the
    // assertion that fails if the report form is ever reused here.
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("select")).toBeNull();

    // The only buttons are the attachment download and the modal's own close.
    const labels = Array.from(container.querySelectorAll("button")).map((b) =>
      (b.textContent ?? "").trim()
    );
    expect(labels).not.toContain("Save");
    expect(labels).not.toContain("Submit");
  });

  it("renders nothing until a ticket is chosen", () => {
    const { container } = render(
      <SupportTicketView ticketId={null} onClose={() => {}} />
    );
    expect(container.textContent).not.toContain("Login button");
  });
});
