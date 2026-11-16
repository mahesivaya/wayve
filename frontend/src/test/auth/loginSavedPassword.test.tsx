// Desktop app: "Remember password on this Mac" on the login page. The desktop
// shell's preload exposes window.fluxzeDesktop.savedLogin (desktop/preload.cjs);
// these tests stand in for it and pin when a login is filled in, saved, or
// forgotten. In a browser (no bridge) the option must not appear at all.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const authLogin = vi.fn();
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ login: authLogin }),
}));

const apiLogin = vi.fn();
vi.mock("../../api/Auth", () => ({
  login: (email: string, password: string) => apiLogin(email, password),
  logout: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../theme/usePublicTheme", () => ({
  usePublicTheme: () => ({ mode: "light" }),
}));

import Login from "../../auth/Login";

type Bridge = {
  get: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
};

function installDesktop(
  saved: { email: string; password: string } | null
): Bridge {
  const bridge = {
    get: vi.fn(() => Promise.resolve(saved)),
    save: vi.fn(() => Promise.resolve(true)),
    clear: vi.fn(() => Promise.resolve()),
  };
  window.fluxzeDesktop = { isDesktop: true, savedLogin: bridge };
  return bridge;
}

function renderLogin(path = "/login") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Login />
    </MemoryRouter>
  );
}

const emailBox = () =>
  screen.getByPlaceholderText("Email or username") as HTMLInputElement;
const passwordBox = () =>
  screen.getByPlaceholderText("Password") as HTMLInputElement;
const rememberBox = () =>
  screen.getByRole("checkbox", {
    name: "Remember password on this Mac",
  }) as HTMLInputElement;

beforeEach(() => {
  authLogin.mockReset();
  apiLogin.mockReset();
  apiLogin.mockResolvedValue({ token: "t", account_type: "personal" });
});

afterEach(() => {
  delete window.fluxzeDesktop;
});

describe("Login: remember password in the desktop app", () => {
  it("offers nothing in a normal browser", () => {
    renderLogin();
    expect(screen.queryByText("Remember password on this Mac")).toBeNull();
  });

  it("offers nothing in an older desktop app without the bridge", () => {
    window.fluxzeDesktop = { isDesktop: true };
    renderLogin();
    expect(screen.queryByText("Remember password on this Mac")).toBeNull();
  });

  it("saves the login after the first successful sign-in", async () => {
    const bridge = installDesktop(null);
    renderLogin();
    expect(rememberBox().checked).toBe(true);

    await userEvent.type(emailBox(), "me@x.com");
    await userEvent.type(passwordBox(), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() =>
      expect(bridge.save).toHaveBeenCalledWith("me@x.com", "secret")
    );
    expect(authLogin).toHaveBeenCalled();
  });

  it("fills in the saved login next time", async () => {
    installDesktop({ email: "me@x.com", password: "secret" });
    renderLogin();

    await waitFor(() => expect(passwordBox().value).toBe("secret"));
    expect(emailBox().value).toBe("me@x.com");
    expect(
      screen.getByRole("button", { name: "Forget saved password" })
    ).toBeTruthy();
  });

  it("does not save when sign-in fails", async () => {
    const bridge = installDesktop(null);
    apiLogin.mockRejectedValue(new Error("401"));
    renderLogin();

    await userEvent.type(emailBox(), "me@x.com");
    await userEvent.type(passwordBox(), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Login" }));

    await screen.findByText("Login failed. Check your credentials.");
    expect(bridge.save).not.toHaveBeenCalled();
    expect(bridge.clear).not.toHaveBeenCalled();
  });

  it("does not save before the email is verified", async () => {
    const bridge = installDesktop(null);
    apiLogin.mockResolvedValue({ error: "email_unverified" });
    renderLogin();

    await userEvent.type(emailBox(), "me@x.com");
    await userEvent.type(passwordBox(), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() => expect(apiLogin).toHaveBeenCalled());
    expect(bridge.save).not.toHaveBeenCalled();
  });

  it("drops the saved login when signing in with the box unticked", async () => {
    const bridge = installDesktop({ email: "me@x.com", password: "secret" });
    renderLogin();
    await waitFor(() => expect(passwordBox().value).toBe("secret"));

    await userEvent.click(rememberBox());
    await userEvent.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() => expect(bridge.clear).toHaveBeenCalled());
    expect(bridge.save).not.toHaveBeenCalled();
  });

  it("forgets the saved login on request", async () => {
    const bridge = installDesktop({ email: "me@x.com", password: "secret" });
    renderLogin();
    await waitFor(() => expect(passwordBox().value).toBe("secret"));

    await userEvent.click(
      screen.getByRole("button", { name: "Forget saved password" })
    );

    expect(bridge.clear).toHaveBeenCalled();
    expect(passwordBox().value).toBe("");
    expect(
      screen.queryByRole("button", { name: "Forget saved password" })
    ).toBeNull();
  });

  it("doesn't fill in a different account than the link brought", async () => {
    installDesktop({ email: "me@x.com", password: "secret" });
    renderLogin("/login?verified=1&email=other%40x.com");

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Forget saved password" })
      ).toBeTruthy()
    );
    expect(emailBox().value).toBe("other@x.com");
    expect(passwordBox().value).toBe("");
  });
});
