// The verify-email screen's Resend timing, mirroring the server: Resend waits
// out the first minute (a resend then would only re-send the same code), and
// the latest code's 10-minute lifetime counts down beside it.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const resendVerification = vi.fn(async (_email: string) => {});
vi.mock("../../api/Auth", () => ({
  verifyEmail: vi.fn(),
  resendVerification: (email: string) => resendVerification(email),
}));
vi.mock("../../theme/usePublicTheme", () => ({
  usePublicTheme: () => ({ mode: "light" }),
}));
vi.mock("../../components/PublicHeader", () => ({ default: () => null }));

import VerifyEmail from "../../auth/VerifyEmail";

const renderScreen = () =>
  render(
    <MemoryRouter initialEntries={["/verify-email?email=a%40x.test"]}>
      <VerifyEmail />
    </MemoryRouter>
  );

const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

describe("VerifyEmail resend timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resendVerification.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("holds Resend for a minute, counting down", async () => {
    renderScreen();
    const button = () => screen.getByRole("button", { name: /Resend/ });
    expect(button().textContent).toBe("Resend in 1:00");
    expect((button() as HTMLButtonElement).disabled).toBe(true);

    await advance(18_000);
    expect(button().textContent).toBe("Resend in 0:42");

    await advance(42_000);
    expect(button().textContent).toBe("Resend code");
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it("restarts both clocks after a resend", async () => {
    renderScreen();
    await advance(5 * 60_000);
    expect(screen.getByText("Your code expires in 5:00.")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resend code" }));
    });
    expect(resendVerification).toHaveBeenCalledWith("a@x.test");
    expect(screen.getByText("Your code expires in 10:00.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Resend/ }).textContent).toBe(
      "Resend in 1:00"
    );
  });

  it("says when the code has expired", async () => {
    renderScreen();
    await advance(10 * 60_000);
    expect(
      screen.getByText("Your code has expired — tap Resend for a new one.")
    ).toBeTruthy();
  });
});
