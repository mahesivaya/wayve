import { useState } from "react";
import { putMeetingAlertMinutes } from "../api/profile";
import { useAuth } from "../auth/useAuth";
import {
  desktopNotificationsEnabled,
  notificationSupport,
  requestNotificationPermission,
  setDesktopNotificationsEnabled,
  type NotificationSupport,
} from "../components/desktopNotifications";
import {
  alertEnabled,
  setAlertEnabled,
  type NotificationChannel,
  type NotificationKind,
} from "../components/notificationPrefs";
import { playChime } from "../components/notificationSound";

const MEETING_LEAD_CHOICES = [0, 5, 10, 15, 30];

const ALERT_ROWS: {
  kind: NotificationKind;
  label: string;
  hint: string;
}[] = [
  { kind: "calls", label: "Calls", hint: "Incoming audio and video calls" },
  {
    kind: "calendar",
    label: "Calendar",
    hint: "Meetings and reminders coming up",
  },
];

function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <span className={`toggle-switch${checked ? " on" : ""}`}>
      <input
        type="checkbox"
        className="toggle-switch-input"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-switch-slider" aria-hidden="true" />
    </span>
  );
}

// Settings › Notifications. What each device alerts about lives on the device (see
// notificationPrefs.ts), except the meeting lead time, which follows the account.
export default function NotificationSettings() {
  const { user, refresh } = useAuth();

  // Derived from `user` rather than mirrored into state, so there's no effect
  // resyncing the two. `pendingLead` is the optimistic override shown while the
  // PUT is in flight; clearing it falls back to whatever the server now says —
  // which reverts the control automatically if the save failed.
  const [pendingLead, setPendingLead] = useState<number | null>(null);
  const [meetingLeadError, setMeetingLeadError] = useState("");
  const meetingLead = pendingLead ?? user?.meeting_alert_minutes ?? 10;
  const changeMeetingLead = async (next: number) => {
    setMeetingLeadError("");
    setPendingLead(next);
    try {
      await putMeetingAlertMinutes(next);
      await refresh();
    } catch (err) {
      setMeetingLeadError(
        err instanceof Error ? err.message : "Could not update setting"
      );
    } finally {
      setPendingLead(null);
    }
  };

  const [permission, setPermission] = useState<NotificationSupport>(() =>
    notificationSupport()
  );
  const [desktopOn, setDesktopOn] = useState(() =>
    desktopNotificationsEnabled()
  );
  const canNotify = permission === "granted" && desktopOn;

  // Bumped on each change, as the switches read their state from storage.
  const [, setRevision] = useState(0);
  const changeAlert = (
    kind: NotificationKind,
    channel: NotificationChannel,
    next: boolean
  ) => {
    setAlertEnabled(kind, channel, next);
    setRevision((n) => n + 1);
    // Switching a sound on is also how to hear what it sounds like.
    if (channel === "sound" && next) playChime();
  };

  return (
    <>
      <section className="settings-card">
        <h2 className="settings-card-title">Permissions</h2>
        <div className="settings-rows">
          <div className="settings-usage-row">
            <span>
              Desktop notifications
              <small>This device only</small>
            </span>
            {permission === "granted" ? (
              <Switch
                label="Desktop notifications"
                checked={desktopOn}
                onChange={(next) => {
                  setDesktopNotificationsEnabled(next);
                  setDesktopOn(next);
                }}
              />
            ) : (
              <button
                type="button"
                className="settings-secondary-btn"
                disabled={
                  permission === "denied" || permission === "unsupported"
                }
                onClick={() =>
                  void requestNotificationPermission().then(setPermission)
                }
              >
                {permission === "denied"
                  ? "Blocked"
                  : permission === "unsupported"
                    ? "Not supported"
                    : "Enable"}
              </button>
            )}
          </div>
        </div>
        <p className="settings-support-empty" style={{ textAlign: "left" }}>
          Notifications only appear while the app or a browser tab is open.
          {permission === "denied" &&
            " They're currently blocked for this site: allow them in your browser or system settings, then reload."}
        </p>
      </section>

      <section className="settings-card">
        <h2 className="settings-card-title">Alerts</h2>
        <div className="settings-alert-list" role="table" aria-label="Alerts">
          <div className="settings-alert-row is-head" role="row">
            <span role="columnheader">Alert for</span>
            <span role="columnheader">Notification</span>
            <span role="columnheader">Sound</span>
          </div>
          {ALERT_ROWS.map(({ kind, label, hint }) => (
            <div className="settings-alert-row" role="row" key={kind}>
              <span role="cell">
                {label}
                <small>{hint}</small>
              </span>
              <span role="cell">
                <Switch
                  label={`${label} notifications`}
                  checked={canNotify && alertEnabled(kind, "notification")}
                  disabled={!canNotify}
                  onChange={(next) => changeAlert(kind, "notification", next)}
                />
              </span>
              <span role="cell">
                <Switch
                  label={`${label} sound`}
                  checked={alertEnabled(kind, "sound")}
                  onChange={(next) => changeAlert(kind, "sound", next)}
                />
              </span>
            </div>
          ))}
        </div>
        <div className="settings-rows">
          <label className="settings-usage-row">
            <span>Alert me before a meeting starts</span>
            <select
              className="settings-select"
              value={meetingLead}
              disabled={pendingLead !== null}
              onChange={(e) => void changeMeetingLead(Number(e.target.value))}
            >
              {MEETING_LEAD_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "Off" : `${m} minutes before`}
                </option>
              ))}
            </select>
          </label>
        </div>
        {meetingLeadError && (
          <p className="settings-danger-error">{meetingLeadError}</p>
        )}
      </section>
    </>
  );
}
