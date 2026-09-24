// The "Fluxze-only" compose checkbox. Its whole promise is that content never
// reaches an external mailbox, so these tests assert the negative: that the SMTP
// path is not taken. The interesting cases are the two silent-downgrade routes
// the mode has to close — a recipient who isn't a Fluxze account, and a
// recipient lookup that fails (which the normal E2E path treats as "external").
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";

const sendEmail = vi.fn().mockResolvedValue({});
const sendInternalEmail = vi.fn().mockResolvedValue({ delivered: 1 });
const getUserByEmail = vi.fn();

vi.mock("../../api/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/email")>()),
  sendEmail: (input: unknown) => sendEmail(input),
  sendInternalEmail: (input: unknown) => sendInternalEmail(input),
  getUserByEmail: (email: string) => getUserByEmail(email),
  filesToAttachments: vi.fn().mockResolvedValue([]),
  searchContacts: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, email: "me@fluxze.test" } }),
}));

vi.mock("../../crypto/keyStore", () => ({
  loadPublicKey: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
}));

vi.mock("../../emails/internalEnvelope", () => ({
  buildInternalEnvelope: vi.fn().mockResolvedValue("WAYVE_SECURE_V1\n{}"),
}));

import SendEmail from "../../emails/SendEmail";

// A Fluxze recipient is only eligible with a non-empty public key, so the
// fixture carries one; omitting it is how the "no key on file" case is built.
const fluxzeUser = (id: number) => ({ id, public_key: [1, 2, 3] });

async function compose(recipients: string, fluxzeOnly = true) {
  render(<SendEmail accountId={7} />);
  fireEvent.change(
    screen.getByPlaceholderText(/separate multiple addresses/i),
    { target: { value: recipients } }
  );
  fireEvent.change(screen.getByPlaceholderText("Subject"), {
    target: { value: "Quarterly numbers" },
  });
  fireEvent.change(screen.getByPlaceholderText("Message"), {
    target: { value: "Internal only." },
  });
  if (fluxzeOnly) {
    fireEvent.click(screen.getByRole("checkbox", { name: /Fluxze-only/i }));
  }
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    // The send handler awaits the recipient lookups, so the queue has to be
    // drained a different way depending on which clock the test installed —
    // a real setTimeout never fires while timers are faked.
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe("Fluxze-only send", () => {
  beforeEach(() => {
    sendEmail.mockClear();
    sendInternalEmail.mockClear();
    getUserByEmail.mockReset();
  });

  it("blocks the whole send when a recipient is not a Fluxze account", async () => {
    getUserByEmail.mockImplementation(async (email: string) =>
      email === "ada@fluxze.test" ? fluxzeUser(2) : null
    );

    await compose("ada@fluxze.test, bob@gmail.com");

    // The point of the mode: nothing goes out at all, not even to the
    // recipient who could have received it.
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendInternalEmail).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText(/Nothing sent/i).textContent).toContain(
        "bob@gmail.com"
      )
    );
  });

  it("blocks rather than downgrading when a recipient lookup fails", async () => {
    // Plain E2E treats a lookup failure as "not on Fluxze" and sends plaintext
    // SMTP. Under Fluxze-only that would be the exact leak the mode prevents.
    getUserByEmail.mockRejectedValue(new Error("network"));

    await compose("ada@fluxze.test");

    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendInternalEmail).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText(/Nothing sent/i).textContent).toMatch(
        /couldn’t be verified|couldn't be verified/i
      )
    );
  });

  it("blocks a Fluxze user who has no public key on file", async () => {
    getUserByEmail.mockResolvedValue({ id: 2, public_key: [] });

    await compose("ada@fluxze.test");

    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendInternalEmail).not.toHaveBeenCalled();
  });

  // Control: proves the assertions above are actually exercising the new gate.
  // With the box unchecked this is the pre-existing behaviour — the external
  // address gets a plaintext SMTP email, which is the leak Fluxze-only closes.
  it("still falls back to SMTP for a non-Fluxze recipient when unchecked", async () => {
    getUserByEmail.mockResolvedValue(null);

    await compose("bob@gmail.com", false);

    await waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: "bob@gmail.com" });
  });

  it("keeps the refusal on screen instead of auto-dismissing it", async () => {
    vi.useFakeTimers();
    try {
      getUserByEmail.mockResolvedValue(null);
      await compose("bob@gmail.com");

      expect(screen.getByRole("alert").textContent).toContain("Nothing sent");

      // Well past the 3s auto-dismiss that every other status gets.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.getByRole("alert").textContent).toContain("Nothing sent");
    } finally {
      vi.useRealTimers();
    }
  });

  // Companion to the test above: proves the 3s dismissal really is running under
  // fake timers, so "still on screen" there means sticky, not a stopped clock.
  it("still auto-dismisses an ordinary status after 3s", async () => {
    vi.useFakeTimers();
    try {
      getUserByEmail.mockResolvedValue(null);
      await compose("bob@gmail.com", false);

      expect(screen.getByText(/sent successfully/i)).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
      });
      expect(screen.queryByText(/sent successfully/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the refusal once the recipients are edited", async () => {
    getUserByEmail.mockResolvedValue(null);
    await compose("bob@gmail.com");
    expect(screen.getByRole("alert")).toBeTruthy();

    fireEvent.change(
      screen.getByPlaceholderText(/separate multiple addresses/i),
      { target: { value: "ada@fluxze.test" } }
    );

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends over the internal channel when every recipient is on Fluxze", async () => {
    getUserByEmail.mockImplementation(async (email: string) =>
      fluxzeUser(email === "ada@fluxze.test" ? 2 : 3)
    );

    await compose("ada@fluxze.test, cara@fluxze.test");

    await waitFor(() => expect(sendInternalEmail).toHaveBeenCalledTimes(1));
    // The SMTP path must stay untouched even on the happy path.
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendInternalEmail.mock.calls[0][0]).toMatchObject({
      recipient_user_ids: [2, 3],
    });
  });
});
