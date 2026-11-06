// Organization (including enterprise) and platform accounts send email with
// basic encryption only: the compose form leaves out End-to-End, Fluxze-only and
// Secure send, and a send goes out as a standard email. Personal accounts keep
// all three options.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const sendEmail = vi.fn().mockResolvedValue({});
const sendInternalEmail = vi.fn().mockResolvedValue({ delivered: 1 });
const getUserByEmail = vi.fn().mockResolvedValue(null);

vi.mock("../../api/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/email")>()),
  sendEmail: (input: unknown) => sendEmail(input),
  sendInternalEmail: (input: unknown) => sendInternalEmail(input),
  getUserByEmail: (email: string) => getUserByEmail(email),
  filesToAttachments: vi.fn().mockResolvedValue([]),
  searchContacts: vi.fn().mockResolvedValue([]),
}));

const auth = vi.hoisted(() => ({ scope: "organization" }));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "me@org.test", scope: auth.scope },
  }),
}));

import SendEmail from "../../emails/SendEmail";
import { emailBasicEncryptionOnly } from "../../emails/emailPolicy";

const options = [/End-to-End Encryption/i, /Fluxze-only/i, /Secure send/i];

describe("basic email encryption for organizations and the platform", () => {
  beforeEach(() => {
    sendEmail.mockClear();
    sendInternalEmail.mockClear();
  });

  it("applies to organization and platform accounts only", () => {
    expect(emailBasicEncryptionOnly({ scope: "organization" })).toBe(true);
    expect(emailBasicEncryptionOnly({ scope: "platform" })).toBe(true);
    expect(
      emailBasicEncryptionOnly({ account_type: "organization_admin" })
    ).toBe(true);
    expect(emailBasicEncryptionOnly({ scope: "personal" })).toBe(false);
    expect(emailBasicEncryptionOnly(null)).toBe(false);
  });

  it("leaves out the encryption options and sends a standard email", async () => {
    auth.scope = "organization";
    render(<SendEmail accountId={7} />);
    for (const name of options) {
      expect(screen.queryByRole("checkbox", { name })).toBeNull();
    }
    expect(screen.queryByText("Advanced Encryption")).toBeNull();

    fireEvent.change(
      screen.getByPlaceholderText(/separate multiple addresses/i),
      { target: { value: "ada@example.com" } }
    );
    fireEvent.change(screen.getByPlaceholderText("Subject"), {
      target: { value: "Hello" },
    });
    fireEvent.change(screen.getByPlaceholderText("Message"), {
      target: { value: "Plain and simple." },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendInternalEmail).not.toHaveBeenCalled();
  });

  it("keeps the options for personal accounts", () => {
    auth.scope = "personal";
    render(<SendEmail accountId={7} />);
    for (const name of options) {
      expect(screen.getByRole("checkbox", { name })).toBeTruthy();
    }
  });
});
