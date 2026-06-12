// Slide-in detail panel for a business, opened from the Business table on the
// platform Business page. Shows the data we already have per org (members,
// email accounts, storage, admin, created date) plus a storage bar shown
// relative to the largest business so the value has visual context (there is
// no per-plan storage quota in the list data yet).
import { useEffect } from "react";
import type { AdminOrganization } from "../api/admin";
import { fmtDateTime } from "../utils/datetime";
import { formatBytes } from "../utils/bytes";
import "./orgDetailDrawer.css";

type Props = {
  org: AdminOrganization;
  /** Largest storage_used_bytes across all businesses, for the relative bar. */
  maxStorageBytes?: number;
  onClose: () => void;
};

export default function OrganizationDetailDrawer({
  org,
  maxStorageBytes = 0,
  onClose,
}: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const storage = org.storage_used_bytes ?? 0;
  const storagePct =
    maxStorageBytes > 0 ? Math.round((storage / maxStorageBytes) * 100) : 0;

  return (
    <div className="org-drawer-backdrop" onClick={onClose}>
      <aside
        className="org-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${org.name} details`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="org-drawer-head">
          <div>
            <h2>{org.name}</h2>
            <span className="org-drawer-sub">Business</span>
          </div>
          <button
            type="button"
            className="org-drawer-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <section className="org-drawer-section">
          <h3>Details</h3>
          <dl className="org-drawer-meta">
            <div>
              <dt>Members</dt>
              <dd>{org.user_count}</dd>
            </div>
            <div>
              <dt>Email accounts</dt>
              <dd>{org.email_account_count ?? 0}</dd>
            </div>
            <div>
              <dt>Admin</dt>
              <dd>{org.admin?.email ?? "—"}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{org.created_at ? fmtDateTime(org.created_at) : "—"}</dd>
            </div>
            {org.slug && (
              <div>
                <dt>Slug</dt>
                <dd>{org.slug}</dd>
              </div>
            )}
          </dl>
        </section>

        <section className="org-drawer-section">
          <h3>Usage</h3>
          <div className="org-drawer-usage">
            <div className="org-drawer-usage-row">
              <span>Storage used</span>
              <strong>{formatBytes(storage)}</strong>
            </div>
            <div
              className="org-drawer-bar"
              role="progressbar"
              aria-valuenow={storagePct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="org-drawer-bar-fill"
                style={{ width: `${storagePct}%` }}
              />
            </div>
            <span className="org-drawer-usage-hint">
              {maxStorageBytes > 0
                ? `${storagePct}% of the largest business (${formatBytes(maxStorageBytes)})`
                : "No storage in use yet"}
            </span>
          </div>
        </section>
      </aside>
    </div>
  );
}
