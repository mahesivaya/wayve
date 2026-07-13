// Admin account creation is a two-step flow: mail a verification code, then
// hand it back. The account must not be created until the code is supplied, so
// these tests assert the first submit only SENDS (never creates), and that the
// code the admin types is what reaches the create call.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const sendAdminCreateCode = vi.fn();
const createAdminUser = vi.fn();
const adminCreateUser = vi.fn();

vi.mock("../../api/admin", () => ({
  sendAdminCreateCode: (...args: unknown[]) => sendAdminCreateCode(...args),
  createAdminUser: (...args: unknown[]) => createAdminUser(...args),
}));

vi.mock("../../api/rbac", () => ({
  adminCreateUser: (...args: unknown[]) => adminCreateUser(...args),
  adminDeleteUser: vi.fn(),
  listOrganizationMembers: vi.fn().mockResolvedValue([]),
  listPlatformMembers: vi.fn().mockResolvedValue([]),
  updateOrganizationMemberRole: vi.fn(),
  updatePlatformMemberRole: vi.fn(),
}));

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      email: "owner@fluxze.com",
      scope: "platform",
      account_type: "platform_admin",
      organization_id: 7,
      organization_slug: "fluxzeone",
      permissions: ["members:read", "members:manage"],
    },
  }),
}));

import OrganizationMembers from "../../organization/OrganizationMembers";
import MembersRolesPanel from "../../organization/MembersRolesPanel";

beforeEach(() => {
  vi.clearAllMocks();
  sendAdminCreateCode.mockResolvedValue({
    sent: true,
    delivery_email: "real.inbox@gmail.com",
    expires_in_minutes: 15,
  });
  createAdminUser.mockResolvedValue({
    id: 9,
    username: "mahesh",
    email: "mahesh@fluxzeone.com",
    account_type: "organization",
  });
  adminCreateUser.mockResolvedValue({
    id: 10,
    username: "newuser",
    email: "newuser@platform.com",
    account_type: "platform_admin",
    organization_id: null,
    role: "member",
    temp_password: "hunter2hunter2aa",
  });
});

describe("organization Create account form", () => {
  const fill = () => {
    fireEvent.change(screen.getByPlaceholderText("e.g. john"), {
      target: { value: "mahesh" },
    });
    fireEvent.change(screen.getByPlaceholderText("At least 6 characters"), {
      target: { value: "password123" },
    });
  };

  it("first submit only sends a code — it does not create the account", async () => {
    render(
      <MemoryRouter>
        <OrganizationMembers />
      </MemoryRouter>
    );
    fill();

    // The delivery address defaults to the account email but is editable: an
    // org login address sits on a synthetic domain with no real inbox.
    const deliveryInput = screen.getByLabelText(/send code to/i);
    expect(deliveryInput).toHaveValue("mahesh@fluxzeone.com");
    fireEvent.change(deliveryInput, {
      target: { value: "real.inbox@gmail.com" },
    });

    fireEvent.click(screen.getByRole("button", { name: /send code/i }));

    await waitFor(() => expect(sendAdminCreateCode).toHaveBeenCalledTimes(1));
    expect(sendAdminCreateCode).toHaveBeenCalledWith(
      "mahesh@fluxzeone.com",
      "real.inbox@gmail.com"
    );
    // The crux: no account yet.
    expect(createAdminUser).not.toHaveBeenCalled();
  });

  it("creates the account with the code the admin types", async () => {
    render(
      <MemoryRouter>
        <OrganizationMembers />
      </MemoryRouter>
    );
    fill();
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));

    // Step 2 appears only after a successful send, and names the inbox.
    const codeInput = await screen.findByLabelText(/verification code/i);
    expect(screen.getByText("real.inbox@gmail.com")).toBeInTheDocument();

    fireEvent.change(codeInput, { target: { value: "424242" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(createAdminUser).toHaveBeenCalledTimes(1));
    expect(createAdminUser).toHaveBeenCalledWith(
      "mahesh",
      "mahesh@fluxzeone.com",
      "password123",
      "personal",
      "",
      "member",
      "424242"
    );
    expect(
      await screen.findByText(/created account mahesh@fluxzeone.com/i)
    ).toBeInTheDocument();
  });

  it("keeps the account uncreated when the code is rejected", async () => {
    createAdminUser.mockRejectedValueOnce(
      new Error("Incorrect verification code")
    );
    render(
      <MemoryRouter>
        <OrganizationMembers />
      </MemoryRouter>
    );
    fill();
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));

    const codeInput = await screen.findByLabelText(/verification code/i);
    fireEvent.change(codeInput, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(
      await screen.findByText(/incorrect verification code/i)
    ).toBeInTheDocument();
    // Still on the code step, so the admin can retype it.
    expect(screen.getByLabelText(/verification code/i)).toBeInTheDocument();
  });
});

describe("platform members panel", () => {
  it("gates creation behind the code step", async () => {
    render(
      <MemoryRouter>
        <MembersRolesPanel scope="platform" />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole("button", { name: /create/i }));
    fireEvent.change(screen.getByPlaceholderText("newuser@platform.com"), {
      target: { value: "newuser@platform.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));

    await waitFor(() => expect(sendAdminCreateCode).toHaveBeenCalledTimes(1));
    expect(adminCreateUser).not.toHaveBeenCalled();

    const codeInput = await screen.findByLabelText(/verification code/i);
    fireEvent.change(codeInput, { target: { value: "555555" } });
    fireEvent.click(screen.getByRole("button", { name: /create user/i }));

    await waitFor(() => expect(adminCreateUser).toHaveBeenCalledTimes(1));
    expect(adminCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "newuser@platform.com",
        account_type: "platform_admin",
        verification_code: "555555",
      })
    );
  });
});
