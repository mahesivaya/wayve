// The alert for a chat message or new mail: a chime and an OS notification,
// each behind its own switch, and no notification while the app is in view.
import { beforeEach, describe, expect, it, vi } from "vitest";

const playChime = vi.hoisted(() => vi.fn());
vi.mock("../../components/notificationSound", () => ({ playChime }));

const desktop = vi.hoisted(() => ({
  appInFocus: vi.fn(() => false),
  showDesktopNotification: vi.fn(() => true),
}));
vi.mock("../../components/desktopNotifications", () => desktop);

import { raiseArrivalAlert } from "../../components/messageAlerts";
import { setAlertEnabled } from "../../components/notificationPrefs";

const alert = { title: "Ada", body: "Lunch?", tag: "chat:dm:7" };

describe("raiseArrivalAlert", () => {
  beforeEach(() => {
    localStorage.clear();
    playChime.mockClear();
    desktop.showDesktopNotification.mockClear();
    desktop.appInFocus.mockReturnValue(false);
  });

  it("chimes and notifies when nobody is looking at the app", () => {
    const onClick = vi.fn();
    raiseArrivalAlert("chats", { ...alert, onClick });
    expect(playChime).toHaveBeenCalledTimes(1);
    expect(desktop.showDesktopNotification).toHaveBeenCalledWith(
      "Ada",
      "Lunch?",
      "chat:dm:7",
      onClick
    );
  });

  it("only chimes while the app is in view", () => {
    desktop.appInFocus.mockReturnValue(true);
    raiseArrivalAlert("emails", alert);
    expect(playChime).toHaveBeenCalledTimes(1);
    expect(desktop.showDesktopNotification).not.toHaveBeenCalled();
  });

  it("follows each kind's own switches", () => {
    setAlertEnabled("chats", "sound", false);
    setAlertEnabled("emails", "notification", false);

    raiseArrivalAlert("chats", alert);
    expect(playChime).not.toHaveBeenCalled();
    expect(desktop.showDesktopNotification).toHaveBeenCalledTimes(1);

    raiseArrivalAlert("emails", alert);
    expect(playChime).toHaveBeenCalledTimes(1);
    expect(desktop.showDesktopNotification).toHaveBeenCalledTimes(1);
  });
});
