import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Login from "../../auth/Login";
import { AuthProvider } from "../../auth/AuthContext";
import { clearAuthToken, getAuthToken } from "../../auth/token";

vi.mock("../../api/Auth", () => ({
  getMe: vi.fn().mockResolvedValue({ ok: false, status: 401 }),
  login: vi.fn(),
  logout: vi.fn(),
  saveUserPublicKey: vi.fn(),
}));
import { login as apiLogin } from "../../api/Auth";

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

    await userEvent.type(screen.getByPlaceholderText("Email"), "a@b.c");
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
    await userEvent.type(screen.getByPlaceholderText("Email"), "a@b.c");
    await userEvent.type(screen.getByPlaceholderText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /^login$/i }));

    expect(await screen.findByText(/login failed/i)).toBeInTheDocument();
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
