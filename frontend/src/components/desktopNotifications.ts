// OS-level desktop notifications for the alert popups.
//
// Deliberately device-local rather than a server-side preference: the browser
// permission is itself per-device, so a server flag would claim "on" for
// devices that never granted it. The server stores *when* to alert
// (users.meeting_alert_minutes); this module stores *whether this browser also
// raises an OS toast*.
//
// No service worker, so these only fire while a Wayve tab is open somewhere —
// the tab need not be focused, but the app must be running.

const ENABLED_KEY = "rwayve.desktopNotifications";

export type NotificationSupport = "unsupported" | NotificationPermission;

export function notificationSupport(): NotificationSupport {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

// Permission is the real opt-in, so an untouched preference means "on" — a user
// who granted permission gets toasts without a second switch to find.
export function desktopNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setDesktopNotificationsEnabled(enabled: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? "on" : "off");
  } catch {
    // Best-effort; the in-app popup still works without persistence.
  }
}

export async function requestNotificationPermission(): Promise<NotificationSupport> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Raise an OS notification. No-ops when unsupported, not permitted, or switched
 * off for this device.
 *
 * `tag` collapses repeats: re-firing with the same tag replaces the existing
 * toast instead of stacking a second one.
 *
 * Returns whether a notification was actually raised, so callers don't record a
 * no-op as "already notified" — otherwise an item on screen when permission is
 * granted would be skipped forever.
 */
export function showDesktopNotification(
  title: string,
  body: string,
  tag: string,
  onClick?: () => void
): boolean {
  if (notificationSupport() !== "granted") return false;
  if (!desktopNotificationsEnabled()) return false;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
    return true;
  } catch {
    // Some browsers throw when constructing a Notification outside a service
    // worker (notably Android Chrome). The in-app card is still shown.
    return false;
  }
}
