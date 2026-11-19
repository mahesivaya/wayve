// The alert for something that just arrived (a chat message, new mail): a chime,
// and an OS notification when nobody is looking at the app. Each is its own
// switch per kind in Settings › Notifications (see notificationPrefs.ts).
import { appInFocus, showDesktopNotification } from "./desktopNotifications";
import { alertEnabled, type NotificationKind } from "./notificationPrefs";
import { playChime } from "./notificationSound";

export type ArrivalAlert = {
  title: string;
  body: string;
  // Collapses repeats: a second alert with the same tag replaces the first
  // notification instead of stacking another.
  tag: string;
  onClick?: () => void;
};

export function raiseArrivalAlert(
  kind: NotificationKind,
  { title, body, tag, onClick }: ArrivalAlert
): void {
  if (alertEnabled(kind, "sound")) playChime();
  // In focus, the app already shows it (a popup card, the list, the badge).
  if (alertEnabled(kind, "notification") && !appInFocus()) {
    showDesktopNotification(title, body, tag, onClick);
  }
}
