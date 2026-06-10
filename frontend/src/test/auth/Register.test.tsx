import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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

const renderAt = (initialEntries: string[]) =>
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider>
        <Register />
      </AuthProvider>
    </MemoryRouter>
  );

describe("Register page", () => {
  afterEach(() => {
    clearAuthToken();
    vi.clearAllMocks();
  });

  it("creates an account on submit", async () => {
    (
      apiRegister as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue({ token: "jwt-x" });

    renderAt(["/register"]);

    await userEvent.type(screen.getByPlaceholderText("Email"), "x@y.z");
    await userEvent.type(screen.getByPlaceholderText("Password"), "secret123");
    await userEvent.type(
      screen.getByPlaceholderText("Confirm Password"),
      "secret123"
    );
    await userEvent.click(screen.getByRole("button", { name: /^register$/i }));

    await waitFor(() => {
      expect(getAuthToken()).toBe("jwt-x");
    });
    expect(localStorage.getItem("token")).toBeNull();
    // Default recovery_mode = "full" — registration always provisions
    // the 24-word mnemonic so a user can recover on a fresh device.
    // The form previously defaulted to "basic" (lowest-friction) but
    // that meant new-device sign-ins couldn't decrypt prior content.
    expect(apiRegister).toHaveBeenCalledWith(
      "x@y.z",
      "secret123",
      "secret123",
      "full"
    );
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
