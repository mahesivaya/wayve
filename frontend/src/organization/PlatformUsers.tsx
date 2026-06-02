import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getUsersSummary, type UsersSummary } from "../api/platformTeam";
import { formatBytes } from "../utils/bytes";
import "./admin-ui.css";
import "./platformAdmin.css";

export default function PlatformUsers() {
  const [data, setData] = useState<UsersSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;

    getUsersSummary()
      .then((summary) => {
        if (alive) setData(summary);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : "Failed to load users");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  const stats = data
    ? [
        { label: "Total users", value: data.users_total.toLocaleString() },
        { label: "New (last month)", value: data.users_new_1m.toLocaleString() },
        { label: "New (last year)", value: data.users_new_1y.toLocaleString() },
        { label: "Total emails", value: data.emails_total.toLocaleString() },
        { label: "Database used", value: formatBytes(data.storage_used_bytes) },
      ]
    : [];

  return (
    <div className="platform-admin-home u-page-shell">
      <div className="platform-admin-header u-panel u-flex-between">
        <div>
          <h1>Users</h1>
          <p>Platform-wide user totals, growth and storage usage.</p>
        </div>
        <Link to="/platform/home" className="u-btn-primary">
          ← Back to platform home
        </Link>
      </div>

      <section className="platform-admin-panel u-panel">
        {loading ? (
          <div className="platform-admin-empty">Loading users…</div>
        ) : error ? (
          <div className="platform-admin-error">{error}</div>
        ) : (
          <div className="platform-stat-grid">
            {stats.map((s) => (
              <div key={s.label} className="platform-stat-block">
                <span className="platform-stat-value">{s.value}</span>
                <span className="platform-stat-label">{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
