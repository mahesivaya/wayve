// Settings › Notifications: the permission, one switch per alert and channel, and
// the prompt that asks once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const auth = vi.hoisted(() => ({
  user: { id: 1, meeting_alert_minutes: 10 },
  refresh: vi.fn(async () => {}),
}));
vi.mock("../../auth/useAuth", () => ({ useAuth: () => auth }));

const playChime = vi.hoisted(() => vi.fn());
vi.mock("../../components/notificationSound", () => ({ playChime }));

const putMeetingAlertMinutes = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../api/profile", () => ({ putMeetingAlertMinutes }));

import NotificationPrompt from "../../components/NotificationPrompt";
import { alertEnabled } from "../../components/notificationPrefs";
import NotificationSettings from "../../profile/NotificationSettings";

const notificationApi = (permission: NotificationPermission) => {
  const api = {
    permission,
    requestPermission: vi.fn(async () => {
      api.permission = "granted";
      return "granted";
    }),
  };
  vi.stubGlobal("Notification", api);
  return api;
};

const toggle = (name: string) =>
  screen.getByRole("switch", { name }) as HTMLInputElement;

describe("notification settings", () => {
  beforeEach(() => {
    localStorage.clear();
    playChime.mockClear();
    putMeetingAlertMinutes.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists a notification and a sound switch for calls and calendar, all on", () => {
    notificationApi("granted");
    render(<NotificationSettings />);
    for (const name of [
      "Desktop notifications",
      "Calls notifications",
      "Calls sound",
      "Calendar notifications",
      "Calendar sound",
    ]) {
      expect(toggle(name).checked).toBe(true);
    }
  });

  it("remembers each switch separately", () => {
    notificationApi("granted");
    const { unmount } = render(<NotificationSettings />);
    fireEvent.click(toggle("Calls sound"));
    expect(alertEnabled("calls", "sound")).toBe(false);
    expect(alertEnabled("calls", "notification")).toBe(true);
    expect(alertEnabled("calendar", "sound")).toBe(true);
    unmount();

    render(<NotificationSettings />);
    expect(toggle("Calls sound").checked).toBe(false);
    expect(toggle("Calendar sound").checked).toBe(true);
  });

  it("plays a preview when a sound is switched on, not off", () => {
    notificationApi("granted");
    render(<NotificationSettings />);
    fireEvent.click(toggle("Calendar sound"));
    expect(playChime).not.toHaveBeenCalled();
    fireEvent.click(toggle("Calendar sound"));
    expect(playChime).toHaveBeenCalledTimes(1);
  });

  it("disables notification switches until permission is granted, but not sounds", async () => {
    const api = notificationApi("default");
    render(<NotificationSettings />);
    expect(toggle("Calls notifications").disabled).toBe(true);
    expect(toggle("Calls notifications").checked).toBe(false);
    expect(toggle("Calls sound").disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() =>
      expect(toggle("Calls notifications").disabled).toBe(false)
    );
    expect(api.requestPermission).toHaveBeenCalledTimes(1);
    expect(toggle("Calls notifications").checked).toBe(true);
  });

  it("switches notifications off everywhere from the top switch", () => {
    notificationApi("granted");
    render(<NotificationSettings />);
    fireEvent.click(toggle("Desktop notifications"));
    expect(toggle("Calls notifications").disabled).toBe(true);
    expect(toggle("Calendar notifications").disabled).toBe(true);
    // Each kind's own choice survives for when it's turned back on.
    expect(alertEnabled("calls", "notification")).toBe(true);
  });

  it("explains a browser block rather than offering a dead button", () => {
    notificationApi("denied");
    render(<NotificationSettings />);
    const blocked = screen.getByRole("button", {
      name: "Blocked",
    }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(screen.getByText(/currently blocked/)).toBeTruthy();
  });

  it("saves the meeting lead time to the account", async () => {
    notificationApi("granted");
    render(<NotificationSettings />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "30" } });
    await waitFor(() =>
      expect(putMeetingAlertMinutes).toHaveBeenCalledWith(30)
    );
    await waitFor(() => expect(auth.refresh).toHaveBeenCalled());
  });
});

describe("the notification prompt", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks once, and only asks the browser when you say yes", async () => {
    const api = notificationApi("default");
    const { unmount } = render(<NotificationPrompt />);
    expect(api.requestPermission).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(api.requestPermission).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();

    api.permission = "default";
    render(<NotificationPrompt />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays away after Not now", () => {
    const api = notificationApi("default");
    const { unmount } = render(<NotificationPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(api.requestPermission).not.toHaveBeenCalled();
    unmount();
    render(<NotificationPrompt />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("doesn't ask when the browser has already answered", () => {
    notificationApi("granted");
    render(<NotificationPrompt />);
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    notificationApi("denied");
    render(<NotificationPrompt />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
