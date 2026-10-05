import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Login from "../../auth/Login";
import { AuthProvider } from "../../auth/AuthContext";
import { clearAuthToken, getAuthToken } from "../../auth/token";
import { AuthDowngradeError } from "../../auth/authKey";

vi.mock("../../api/Auth", () => ({
  getMe: vi.fn().mockResolvedValue({ ok: false, status: 401 }),
  login: vi.fn(),
  logout: vi.fn(),
  saveUserPublicKey: vi.fn(),
}));
import { login as apiLogin, logout as apiLogout } from "../../api/Auth";

vi.mock("../../orgKeys/memberLogin", () => ({
  unwrapAndCacheMemberKeys: vi.fn(),
}));
import { unwrapAndCacheMemberKeys } from "../../orgKeys/memberLogin";

// HS256 JWT so parseJwt yields claims: { "sub": 99, "email": "alice@example.com", "exp": 9999999999 }
const VALID_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOjk5LCJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIiwiZXhwIjo5OTk5OTk5OTk5fQ." +
  "Yfk2GANHfoqcl3T1jbBhHptPj0xK_e3pGE9pq5VtZ8I";

const renderAt = (initialEntries: string[]) =>
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider>
        <Login />
      </AuthProvider>
    </MemoryRouter>
  );

describe("Login page", () => {
  afterEach(() => {
    clearAuthToken();
    vi.clearAllMocks();
  });

  it("submits credentials and keeps the token out of localStorage", async () => {
    (
      apiLogin as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue({ token: "jwt-1" });

    renderAt(["/login"]);

    await userEvent.type(
      screen.getByPlaceholderText("Email or username"),
      "a@b.c"
    );
    await userEvent.type(screen.getByPlaceholderText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: /^login$/i }));

    await waitFor(() => {
      expect(getAuthToken()).toBe("jwt-1");
    });
    expect(localStorage.getItem("token")).toBeNull();
    expect(apiLogin).toHaveBeenCalledWith("a@b.c", "pw");
  });

  it("shows inline error on auth failure", async () => {
    (
      apiLogin as unknown as { mockRejectedValue: (v: unknown) => void }
    ).mockRejectedValue(new Error("bad creds"));

    renderAt(["/login"]);
    await userEvent.type(
      screen.getByPlaceholderText("Email or username"),
      "a@b.c"
    );
    await userEvent.type(screen.getByPlaceholderText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /^login$/i }));

    expect(await screen.findByText(/login failed/i)).toBeInTheDocument();
  });

  it("signs out when the login key envelope can't be unwrapped", async () => {
    // /api/login already set the session cookie; leaving it in place let a
    // refresh land in the account with no keys and prompt for the recovery key.
    vi.mocked(apiLogin).mockResolvedValue({
      token: VALID_JWT,
      email: "alice@example.com",
      login_wrap: { iv: "iv", ct: "ct", salt: "salt", iterations: 1 },
    });
    vi.mocked(apiLogout).mockResolvedValue(undefined);
    vi.mocked(unwrapAndCacheMemberKeys).mockRejectedValue(
      new Error("unwrap failed")
    );

    renderAt(["/login"]);
    await userEvent.type(
      screen.getByPlaceholderText("Email or username"),
      "alice@example.com"
    );
    await userEvent.type(screen.getByPlaceholderText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: /^login$/i }));

    expect(
      await screen.findByText(/couldn't unlock your account keys/i)
    ).toBeInTheDocument();
    expect(apiLogout).toHaveBeenCalledTimes(1);
    expect(getAuthToken()).toBeNull();
  });

  it("shows the downgrade warning instead of a generic failure", async () => {
    vi.mocked(apiLogin).mockRejectedValue(new AuthDowngradeError());

    renderAt(["/login"]);
    await userEvent.type(
      screen.getByPlaceholderText("Email or username"),
      "a@b.c"
    );
    await userEvent.type(screen.getByPlaceholderText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: /^login$/i }));

    expect(await screen.findByText(/less secure form/i)).toBeInTheDocument();
  });

  it("shows email_exists banner when redirected from OAuth", () => {
    renderAt(["/login?error=email_exists"]);
    expect(
      screen.getByText(/already registered with a password/i)
    ).toBeInTheDocument();
  });

  it("renders the Continue with Gmail button and Forgot password link", () => {
    renderAt(["/login"]);
    expect(
      screen.getByRole("button", { name: /continue with gmail/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/forgot password/i)).toBeInTheDocument();
  });
});
