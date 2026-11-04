import { useState } from "react";
import {
  notificationSupport,
  requestNotificationPermission,
} from "./desktopNotifications";
import "./meetingReminders.css";

const DISMISSED_KEY = "rwayve.notificationPrompt.dismissed";

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

// Asks once per device for permission to raise desktop notifications, in the app's
// own words first: a browser may refuse a permission request made without a click,
// and a refusal is hard to undo. Settings › Notifications stays the way back.
export default function NotificationPrompt() {
  const [visible, setVisible] = useState(
    () => notificationSupport() === "default" && !wasDismissed()
  );
  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Best-effort; it just asks again next time.
    }
    setVisible(false);
  };

  return (
    <div
      className="notification-prompt"
      role="dialog"
      aria-label="Notifications"
    >
      <div className="meeting-reminder-title">Turn on notifications?</div>
      <div className="meeting-reminder-time">
        Get alerted about calls and meetings when you&apos;re in another window.
      </div>
      <div className="meeting-reminder-actions">
        <button
          type="button"
          className="meeting-reminder-open"
          onClick={dismiss}
        >
          Not now
        </button>
        <button
          type="button"
          className="meeting-reminder-open"
          onClick={() => {
            void requestNotificationPermission();
            dismiss();
          }}
        >
          Turn on
        </button>
      </div>
    </div>
  );
}
