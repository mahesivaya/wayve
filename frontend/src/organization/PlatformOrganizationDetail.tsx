import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { listAdminOrganizations, type AdminOrganization } from "../api/admin";
import { formatBytes } from "../utils/bytes";
import "./admin-ui.css";
import "./platformAdmin.css";

type FromTab = "enterprise" | "organizations";

export default function PlatformOrganizationDetail() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const from: FromTab =
    (location.state as { from?: FromTab } | null)?.from === "enterprise"
      ? "enterprise"
      : "organizations";
  const back =
    from === "enterprise"
      ? { to: "/platform/enterprise", label: "← Back to enterprises" }
      : { to: "/platform/organizations", label: "← Back to businesses" };

  const orgId = id ? Number(id) : NaN;

  const [organizations, setOrganizations] = useState<AdminOrganization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;

    listAdminOrganizations()
      .then((items) => {
        if (alive) setOrganizations(items);
      })
      .catch((err) => {
        if (alive)
          setError(
            err instanceof Error ? err.message : "Failed to load business"
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  const org = useMemo(
    () => organizations.find((o) => o.id === orgId) ?? null,
    [organizations, orgId]
  );

  return (
    <div className="platform-admin-home u-page-shell">
      <div className="platform-admin-header u-panel u-flex-between">
        <div>
          <h1>{org ? org.name : "Business"}</h1>
          <p>Email accounts and memory used by this account.</p>
        </div>
        <Link to={back.to} className="u-btn-primary">
          {back.label}
        </Link>
      </div>

      <section className="platform-admin-panel u-panel">
        {loading ? (
          <div className="platform-admin-empty">Loading details…</div>
        ) : error ? (
          <div className="platform-admin-error">{error}</div>
        ) : !org ? (
          <div className="platform-admin-empty">Business not found.</div>
        ) : (
          <>
            <div className="platform-stat-grid">
              <div className="platform-stat-block">
                <span className="platform-stat-value">
                  {(org.email_account_count ?? 0).toLocaleString()}
                </span>
                <span className="platform-stat-label">
                  Total email accounts
                </span>
              </div>
              <div className="platform-stat-block">
                <span className="platform-stat-value">
                  {formatBytes(org.storage_used_bytes ?? 0)}
                </span>
                <span className="platform-stat-label">Total memory used</span>
              </div>
              <div className="platform-stat-block">
                <span className="platform-stat-value">
                  {(org.user_count ?? 0).toLocaleString()}
                </span>
                <span className="platform-stat-label">Members</span>
              </div>
            </div>

            {org.admin?.email && (
              <p className="organization-detail-admin">
                Admin: <strong>{org.admin.email}</strong>
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
