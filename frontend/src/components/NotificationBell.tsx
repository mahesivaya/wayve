import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { BellIcon, ReminderIcon } from "../icons";
import { useStorageStatus } from "./useStorageStatus";
import "./notificationBell.css";

type NotificationBellProps = {
  emailUnread: number;
  chatUnread: number;
  /** "header" is the original top-bar bell; "sidebar" renders a nav row. */
  variant?: "header" | "sidebar";
};

// Clicking the bell opens the full Reminders page. Counts arrive as props from
// the same hooks that feed the sidebar badges, so the badge stays in lock-step;
// a low-storage alert adds one so the bell surfaces it too.
export default function NotificationBell({
  emailUnread,
  chatUnread,
  variant = "header",
}: NotificationBellProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { level: storageLevel } = useStorageStatus();

  if (!user) return null;

  const total =
    Math.max(0, emailUnread) +
    Math.max(0, chatUnread) +
    (storageLevel === "none" ? 0 : 1);

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
          title="Reminders"
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
        aria-label={total > 0 ? `${total} unread reminders` : "Reminders"}
        title="Reminders"
      >
        <BellIcon size={20} />
        {badge}
      </button>
    </div>
  );
}
