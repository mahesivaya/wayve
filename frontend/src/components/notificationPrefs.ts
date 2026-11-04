// Which alerts this device raises, per kind of event and per channel. Device-local
// like the desktop notification switch (see desktopNotifications.ts): whether a
// laptop should ring says nothing about a phone. Every switch starts on, since the
// browser's permission is the real opt-in for notifications.
const STORAGE_KEY = "rwayve.notificationPrefs";

export type NotificationKind = "calls" | "calendar";
export type NotificationChannel = "notification" | "sound";

const prefKey = (kind: NotificationKind, channel: NotificationChannel) =>
  `${kind}.${channel}`;

function readPrefs(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}"
    );
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function alertEnabled(
  kind: NotificationKind,
  channel: NotificationChannel
): boolean {
  return readPrefs()[prefKey(kind, channel)] !== false;
}

export function setAlertEnabled(
  kind: NotificationKind,
  channel: NotificationChannel,
  enabled: boolean
): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...readPrefs(), [prefKey(kind, channel)]: enabled })
    );
  } catch {
    // Best-effort; the alert just stays at its default.
  }
}
