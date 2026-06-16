import { useCallback, useEffect, useState } from "react";
import { getProfile } from "../api/profile";
import { useAuth } from "../auth/useAuth";

// Single source of truth for the storage/memory limit alert, shared by the
// StorageLimitBanner and the NotificationBell so they always agree and gate to
// the same audience.
//
// Audience (per product decision): alert ONLY personal accounts and
// organization OWNERS. All other organization members and platform-scope users
// never see the alert — they can't act on an org/personal storage cap.

// Warn once usage crosses 90% of the plan's storage limit; "critical" at 100%.
export const WARN_THRESHOLD = 0.9;

// Fired by other surfaces (e.g. Drive upload/delete in DriveBox) so consumers
// re-check usage immediately instead of waiting for the next focus/poll.
export const STORAGE_CHANGED_EVENT = "rwayve:storage-changed";

export type StorageLevel = "none" | "warn" | "critical";

export function formatBytes(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(2)} GB`;
}

export type StorageStatus = {
  used: number | null;
  limit: number | null;
  pct: number | null;
  level: StorageLevel;
  refresh: () => void;
};

export function useStorageStatus(): StorageStatus {
  const { user } = useAuth();
  const [used, setUsed] = useState<number | null>(null);
  const [limit, setLimit] = useState<number | null>(null);

  const refresh = useCallback(() => {
    getProfile()
      .then((p) => {
        setUsed(p.memory_used_bytes ?? null);
        setLimit(p.memory_limit_bytes ?? null);
      })
      .catch(() => {
        // Keep previous values on a transient failure; a wrong "full" alert is
        // worse than briefly stale data.
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

  // Allow-list audience: personal accounts OR organization owners only.
  const isPersonal =
    user?.account_type === "personal" ||
    (user?.scope !== "organization" && user?.scope !== "platform");
  const isOrgOwner =
    user?.scope === "organization" && user?.effective_role === "owner";
  const eligible = Boolean(user) && (isPersonal || isOrgOwner);

  // pct is only meaningful for a finite limit (> 0). Unlimited plans (limit <= 0)
  // and missing data yield level "none".
  const pct =
    used !== null && limit !== null && limit > 0 ? used / limit : null;

  let level: StorageLevel = "none";
  if (eligible && pct !== null) {
    if (pct >= 1) level = "critical";
    else if (pct >= WARN_THRESHOLD) level = "warn";
  }

  return { used, limit, pct, level, refresh };
}
