import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { BellIcon, ReminderIcon } from "../icons";
import { useRemindersCount } from "./useRemindersCount";
import "./notificationBell.css";

type NotificationBellProps = {
  /** "header" is the original top-bar bell; "sidebar" renders a nav row. */
  variant?: "header" | "sidebar";
};

// Clicking opens the full Reminders page. The badge shows the user's reminder
// count so it stays in lock-step with the reminders list (it used to show the
// unread mail + chat total, which had nothing to do with reminders).
export default function NotificationBell({
  variant = "header",
}: NotificationBellProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const total = useRemindersCount(Boolean(user));

  if (!user) return null;

  const badge =
    total > 0 ? (
      <span className={variant === "sidebar" ? "sidebar-badge" : "notif-badge"}>
        {total > 99 ? "99+" : total}
      </span>
    ) : null;

  const open = () => void navigate("/reminders");

  if (variant === "sidebar") {
    return (
      <div className="notif-bell notif-bell--sidebar">
        <button
          type="button"
          className="sidebar-link notif-sidebar-trigger"
          onClick={open}
          data-tooltip="Reminders"
        >
          <span className="sidebar-icon" aria-hidden="true">
            <ReminderIcon size={18} />
          </span>
          <span className="sidebar-label">Reminders</span>
          {badge}
        </button>
      </div>
    );
  }

  return (
    <div className="notif-bell">
      <button
        type="button"
        className="notif-bell-btn"
        onClick={open}
        aria-label={total > 0 ? `${total} reminders` : "Reminders"}
        data-tooltip="Reminders"
      >
        <BellIcon size={20} />
        {badge}
      </button>
    </div>
  );
}
