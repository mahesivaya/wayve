import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listAdminOrganizations, type AdminOrganization } from "../api/admin";
import { formatBytes } from "../utils/bytes";
import OrganizationDetailDrawer from "./OrganizationDetailDrawer";
import "./admin-ui.css";
import "./platformAdmin.css";

export default function PlatformEnterprises() {
  const [enterprises, setEnterprises] = useState<AdminOrganization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedOrg, setSelectedOrg] = useState<AdminOrganization | null>(
    null
  );

  useEffect(() => {
    let alive = true;

    listAdminOrganizations()
      .then((items) => {
        // Enterprise page: only orgs on the enterprise tier.
        if (alive)
          setEnterprises(items.filter((org) => org.tier === "enterprise"));
      })
      .catch((err) => {
        if (alive)
          setError(
            err instanceof Error ? err.message : "Failed to load enterprises"
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  const totals = useMemo(() => {
    return enterprises.reduce(
      (acc, ent) => ({
        storage: acc.storage + (ent.storage_used_bytes ?? 0),
        emailAccounts: acc.emailAccounts + (ent.email_account_count ?? 0),
      }),
      { storage: 0, emailAccounts: 0 }
    );
  }, [enterprises]);

  return (
    <div className="platform-admin-home u-page-shell">
      <div className="platform-admin-header u-panel u-flex-between">
        <div>
          <h1>Enterprise</h1>
          <p>All enterprises currently available on the platform.</p>
        </div>
        <Link to="/platform/home" className="u-btn-primary">
          ← Back to platform home
        </Link>
      </div>

      <section className="platform-admin-panel u-panel">
        {loading ? (
          <div className="platform-admin-empty">Loading enterprises…</div>
        ) : error ? (
          <div className="platform-admin-error">{error}</div>
        ) : enterprises.length === 0 ? (
          <div className="platform-admin-empty">No enterprises yet.</div>
        ) : (
          <>
            <div className="platform-stat-grid">
              <div className="platform-stat-block">
                <span className="platform-stat-value">
                  {formatBytes(totals.storage)}
                </span>
                <span className="platform-stat-label">Total memory used</span>
              </div>
              <div className="platform-stat-block">
                <span className="platform-stat-value">
                  {totals.emailAccounts.toLocaleString()}
                </span>
                <span className="platform-stat-label">
                  Total email accounts
                </span>
              </div>
            </div>

            <div className="organization-grid organization-grid--stats">
              {enterprises.map((ent) => (
                <button
                  key={ent.id}
                  type="button"
                  className="organization-grid-tile organization-grid-tile--stats"
                  title={ent.name}
                  onClick={() => setSelectedOrg(ent)}
                >
                  <strong>{ent.name}</strong>
                  <span className="organization-tile-stats">
                    <span>{formatBytes(ent.storage_used_bytes ?? 0)} used</span>
                    <span>
                      {(ent.email_account_count ?? 0).toLocaleString()} email
                      accounts
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      {selectedOrg && (
        <OrganizationDetailDrawer
          org={selectedOrg}
          maxStorageBytes={Math.max(
            0,
            ...enterprises.map((e) => e.storage_used_bytes ?? 0)
          )}
          onClose={() => setSelectedOrg(null)}
        />
      )}
    </div>
  );
}
