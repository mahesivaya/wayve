import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useSearchParams } from "react-router-dom";
import Register from "../../auth/Register";
import { AuthProvider } from "../../auth/AuthContext";
import { clearAuthToken, getAuthToken } from "../../auth/token";

vi.mock("../../api/Auth", () => ({
  getMe: vi.fn().mockResolvedValue({ ok: false, status: 401 }),
  logout: vi.fn(),
  register: vi.fn(),
  saveUserPublicKey: vi.fn(),
}));
import { register as apiRegister } from "../../api/Auth";

// Stand-in for the real VerifyEmail page, so we can assert the post-submit
// redirect landed and carried the email through.
function VerifyEmailStub() {
  const [params] = useSearchParams();
  return <div data-testid="verify-email">{params.get("email")}</div>;
}

const renderAt = (initialEntries: string[]) =>
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider>
        <Routes>
          <Route path="/register" element={<Register />} />
          <Route path="/verify-email" element={<VerifyEmailStub />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );

describe("Register page", () => {
  afterEach(() => {
    clearAuthToken();
    vi.clearAllMocks();
  });

  it("creates an account then redirects to email verification (no auto-login)", async () => {
    (
      apiRegister as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue(undefined);

    renderAt(["/register"]);

    await userEvent.type(screen.getByPlaceholderText("Email"), "x@y.z");
    await userEvent.type(screen.getByPlaceholderText("Password"), "secret123");
    await userEvent.type(
      screen.getByPlaceholderText("Confirm Password"),
      "secret123"
    );
    await userEvent.click(screen.getByRole("button", { name: /^register$/i }));

    // recovery_mode = "full": every signup provisions the 24-word mnemonic so a
    // user can recover on a fresh device.
    await waitFor(() => {
      expect(apiRegister).toHaveBeenCalledWith(
        "x@y.z",
        "secret123",
        "secret123",
        "full"
      );
    });

    // The account is created unverified: the user must enter the emailed 6-digit
    // code before their first login, and that login — not this form — sets up the
    // session, E2E keypair and recovery phrase. So there is deliberately no token.
    expect(await screen.findByTestId("verify-email")).toHaveTextContent(
      "x@y.z"
    );
    expect(getAuthToken()).toBeNull();
    expect(localStorage.getItem("token")).toBeNull();
  });

  it("rejects mismatched passwords without calling API", async () => {
    renderAt(["/register"]);
    await userEvent.type(screen.getByPlaceholderText("Email"), "a@b.c");
    await userEvent.type(screen.getByPlaceholderText("Password"), "abc123");
    await userEvent.type(
      screen.getByPlaceholderText("Confirm Password"),
      "different"
    );
    await userEvent.click(screen.getByRole("button", { name: /^register$/i }));

    expect(
      await screen.findByText(/passwords do not match/i)
    ).toBeInTheDocument();
    expect(apiRegister).not.toHaveBeenCalled();
  });

  it("shows email_exists banner from OAuth redirect", () => {
    renderAt(["/register?error=email_exists"]);
    expect(screen.getByText(/already registered/i)).toBeInTheDocument();
  });

  it("renders Sign up with Google button", () => {
    renderAt(["/register"]);
    expect(
      screen.getByRole("button", { name: /sign up with google/i })
    ).toBeInTheDocument();
  });
});
