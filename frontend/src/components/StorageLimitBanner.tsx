import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { getProfile } from "../api/profile";
import "./StorageLimitBanner.css";

// Show the alert once usage crosses 90% of the plan's storage limit; switch to
// the blocking "critical" treatment at 100%. Tunable here.
const WARN_THRESHOLD = 0.9;
const DISMISS_KEY = "rwayve:storage-alert-dismissed";
// Fired by other surfaces (e.g. Drive upload) so the banner re-checks usage
// immediately instead of waiting for the next focus/poll.
export const STORAGE_CHANGED_EVENT = "rwayve:storage-changed";

function formatBytes(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(2)} GB`;
}

type Props = {
  // Reuses Layout's existing upgrade navigation so the button lands on the
  // inline Stripe upgrade flow at /billing.
  onUpgrade: () => void;
};

export default function StorageLimitBanner({ onUpgrade }: Props) {
  const location = useLocation();
  const [used, setUsed] = useState<number | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem(DISMISS_KEY) === "1"
  );

  const refresh = useCallback(() => {
    getProfile()
      .then((p) => {
        setUsed(p.memory_used_bytes ?? null);
        setLimit(p.memory_limit_bytes ?? null);
      })
      .catch(() => {
        // Keep the previous values on a transient failure; a wrong "full"
        // alert is worse than briefly stale data.
      });
  }, []);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener(STORAGE_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(STORAGE_CHANGED_EVENT, refresh);
    };
  }, [refresh]);

  // Redundant on the billing page; hide when data is missing or the plan is
  // unlimited (limit <= 0 for org/enterprise).
  if (location.pathname.startsWith("/billing")) return null;
  if (used === null || limit === null || limit <= 0) return null;

  const pct = used / limit;
  if (pct < WARN_THRESHOLD) return null;

  const critical = pct >= 1;
  // Warning is dismissible for the session; the critical (blocked) state stays
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
