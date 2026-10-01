// The profile password card: a Google signup with no password gets "Create
// password" (new + confirm, no current-password field); an account with a
// password gets "Change password" (current + new + confirm), even when its
// provider is still "google"; and nothing is offered before /api/profile
// answers, which is how a Google signup used to see a current-password field.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProfileData } from "../../api/profile";

const getProfile = vi.fn<() => Promise<ProfileData>>();
const changePassword = vi.fn();

vi.mock("../../api/profile", () => ({
  getProfile: () => getProfile(),
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
}));
vi.mock("../../api/Auth", () => ({
  changePassword: (...args: unknown[]) => changePassword(...args),
}));
vi.mock("../../orgKeys/memberLogin", () => ({
  buildLoginWrapForPassword: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 7, email: "me@x.test", account_type: "personal" },
  }),
}));
vi.mock("../../profile/SettingsShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/Avatar", () => ({ default: () => null }));

import Profile from "../../profile/Profile";

const profile = (over: Partial<ProfileData>): ProfileData => ({
  id: 7,
  email: "me@x.test",
  first_name: null,
  last_name: null,
  auth_provider: "google",
  ...over,
});

beforeEach(() => {
  getProfile.mockReset();
  changePassword.mockReset();
});

describe("profile password card", () => {
  it("lets a Google signup create a password without a current one", async () => {
    getProfile.mockResolvedValue(profile({ has_password: false }));
    changePassword.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Profile />);

    await user.click(
      await screen.findByRole("button", { name: "Create Password" })
    );
    expect(screen.queryByLabelText("Current password")).toBeNull();

    await user.type(screen.getByLabelText("Password"), "brand-new-1");
    await user.type(screen.getByLabelText("Confirm password"), "brand-new-1");
    await user.click(screen.getByRole("button", { name: "Create password" }));

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith(null, "brand-new-1", null)
    );
    // Afterwards it's a change, which needs the current password.
    expect(
      await screen.findByRole("button", { name: "Change Password" })
    ).toBeTruthy();
  });

  it("asks for the current password once one exists, even for Google", async () => {
    getProfile.mockResolvedValue(profile({ has_password: true }));
    const user = userEvent.setup();
    render(<Profile />);

    await user.click(
      await screen.findByRole("button", { name: "Change Password" })
    );
    expect(screen.getByLabelText("Current password")).toBeTruthy();
    expect(screen.getByLabelText("New password")).toBeTruthy();
    expect(screen.getByLabelText("Confirm new password")).toBeTruthy();
  });

  it("offers nothing until the profile has loaded", () => {
    getProfile.mockReturnValue(new Promise(() => {}));
    render(<Profile />);
    const button = screen.getByRole("button", { name: "Loading…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("tells single sign-on accounts they have no password", async () => {
    getProfile.mockResolvedValue(
      profile({ auth_provider: "sso", has_password: false })
    );
    render(<Profile />);
    expect(await screen.findByText(/single sign-on/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Password/ })).toBeNull();
  });
});
