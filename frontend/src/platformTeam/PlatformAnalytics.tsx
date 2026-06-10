import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { SupportSummary, getSupportSummary } from "../api/platformTeam";
import { fmtDate } from "../utils/datetime";
import "./platformTeam.css";

export default function PlatformAnalytics() {
  const { user } = useAuth();
  const canView =
    user?.scope === "platform" && hasPermission(user, "members:read");

  const [data, setData] = useState<SupportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    if (!canView) return;
    setError("");
    try {
      setData(await getSupportSummary());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    const h = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(h);
  }, [reload]);

  if (!canView) return <Navigate to="/" replace />;
  if (loading) return <div className="pt-loader">Loading analytics…</div>;

  return (
    <div className="pt-page">
      <header className="pt-header">
        <h1>Analytics</h1>
        <p>Platform-wide growth, tenants and signup activity · {user?.email}</p>
      </header>

      {error && <div className="pt-banner">{error}</div>}

      <section className="pt-stats">
        <Stat
          label="Users"
          value={data?.users_total ?? 0}
          sub={`+${data?.users_new_24h ?? 0} today · +${data?.users_new_7d ?? 0} this week`}
        />
        <Stat
          label="Organizations"
          value={data?.orgs_total ?? 0}
          sub="Active tenants"
        />
        <Stat
          label="Active subscriptions"
          value={data?.active_subs ?? 0}
          sub={`${data?.past_due ?? 0} past due`}
          alert={(data?.past_due ?? 0) > 0}
        />
        <Stat
          label="Open inbox threads"
          value={data?.open_inbox_threads ?? 0}
          sub={`${data?.pending_inbox_threads ?? 0} pending`}
        />
        <Stat
          label="Connected mailboxes"
          value={data?.connected_mailboxes ?? 0}
          sub={`${data?.shared_inboxes ?? 0} shared`}
        />
      </section>

      <div className="pt-grid">
        <section className="pt-panel">
          <div className="pt-panel-head">
            <h2>Top organizations</h2>
            <span className="pt-stat-sub">By active member count</span>
          </div>
          {data && data.top_organizations.length > 0 ? (
            <table className="pt-table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Plan</th>
                  <th className="right">Members</th>
                  <th className="right">Mailboxes</th>
                </tr>
              </thead>
              <tbody>
                {data.top_organizations.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.name}</strong>
                      {row.slug && (
                        <>
                          <br />
                          <small style={{ color: "#6b7280" }}>{row.slug}</small>
                        </>
                      )}
                    </td>
                    <td>
                      {row.plan_name ?? "—"}{" "}
                      <span className={`pt-pill ${row.sub_status}`}>
                        {row.sub_status}
                      </span>
                    </td>
                    <td className="right">{row.member_count}</td>
                    <td className="right">{row.mailboxes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="pt-empty">No organizations yet.</div>
          )}
        </section>

        <section className="pt-panel">
          <div className="pt-panel-head">
            <h2>Recent signups</h2>
            <span className="pt-stat-sub">Last 15</span>
          </div>
          {data && data.recent_signups.length > 0 ? (
            <table className="pt-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Type</th>
                  <th>Provider</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {data.recent_signups.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.email}</strong>
                      {row.username && (
                        <>
                          <br />
                          <small style={{ color: "#6b7280" }}>
                            {row.username}
                          </small>
                        </>
                      )}
                    </td>
                    <td>
                      <span className="pt-pill info">{row.account_type}</span>
                    </td>
                    <td>{row.auth_provider ?? "local"}</td>
                    <td>{fmtDate(row.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="pt-empty">No signups recorded.</div>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  alert,
}: {
  label: string;
  value: number | string;
  sub?: string;
  alert?: boolean;
}) {
  return (
    <div className={`pt-stat ${alert ? "alert" : ""}`}>
      <span className="pt-stat-label">{label}</span>
      <span className="pt-stat-value">{value}</span>
      {sub && <span className="pt-stat-sub">{sub}</span>}
    </div>
  );
}
