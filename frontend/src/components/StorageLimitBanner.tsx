import { useState } from "react";
import { useLocation } from "react-router-dom";
import {
  useStorageStatus,
  formatBytes,
  STORAGE_CHANGED_EVENT,
} from "./useStorageStatus";
import "./StorageLimitBanner.css";

// Re-exported for back-compat with any caller that imported it from here.
export { STORAGE_CHANGED_EVENT };

const DISMISS_KEY = "rwayve:storage-alert-dismissed";

type Props = {
  onUpgrade: () => void;
};

export default function StorageLimitBanner({ onUpgrade }: Props) {
  const location = useLocation();
  // Usage, level and audience gating live in the shared hook so this banner and
  // the NotificationBell stay in lock-step.
  const { used, limit, pct, level } = useStorageStatus();
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem(DISMISS_KEY) === "1"
  );

  // Redundant on the billing page.
  if (location.pathname.startsWith("/billing")) return null;
  if (level === "none" || used === null || limit === null || pct === null) {
    return null;
  }

  const critical = level === "critical";
  // The warning is dismissible for the session, but the critical state persists
  // until the user frees space or upgrades.
  if (!critical && dismissed) return null;

  const pctLabel = Math.min(999, Math.round(pct * 100));

  const dismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  return (
    <div
      className={`storage-alert ${critical ? "is-critical" : ""}`}
      role="alert"
    >
      <span className="storage-alert-text">
        {critical
          ? `You've reached your ${formatBytes(limit)} storage limit (${pctLabel}% used). Uploads are blocked until you free space or upgrade.`
          : `You've used ${formatBytes(used)} of ${formatBytes(limit)} (${pctLabel}%). You're almost out of space.`}
      </span>
      <span className="storage-alert-actions">
        <button
          type="button"
          className="storage-alert-upgrade"
          onClick={onUpgrade}
        >
          Upgrade now
        </button>
        {!critical && (
          <button
            type="button"
            className="storage-alert-dismiss"
            onClick={dismiss}
            aria-label="Dismiss"
          >
            ×
          </button>
        )}
      </span>
    </div>
  );
}
