import { useCallback, useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasAnyPermission } from "../auth/permissions";
import {
  DeveloperSummary,
  getDeveloperSummary,
} from "../api/platformTeam";
import "./platformTeam.css";

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function statusClass(code: number, outcome: string): string {
  if (outcome === "allowed" && code < 400) return "ok";
  return "error";
}

export default function PlatformDeveloper() {
  const { user } = useAuth();
  const canView =
    user?.scope === "platform" &&
    hasAnyPermission(user, ["logs:read", "logs:read_limited", "api_keys:manage"]);

  const [data, setData] = useState<DeveloperSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    if (!canView) return;
    setError("");
    try {
      setData(await getDeveloperSummary());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load developer summary");
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    const h = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(h);
  }, [reload]);

  if (!canView) return <Navigate to="/" replace />;
  if (loading) return <div className="pt-loader">Loading developer console…</div>;

  return (
    <div className="pt-page">
      <header className="pt-header">
        <h1>Developer Console</h1>
        <p>
          API keys, audit traffic, webhooks and integrations across the platform · {user?.email}
        </p>
      </header>

      {error && <div className="pt-banner">{error}</div>}

      <section className="pt-stats">
        <Stat label="API keys (active)" value={data?.keys_active ?? 0} sub={`${data?.keys_total ?? 0} total · ${data?.keys_expired ?? 0} expired`} />
        <Stat label="Calls (24h)" value={data?.audit_24h ?? 0} sub={`${data?.audit_7d ?? 0} last 7 days`} />
        <Stat
          label="Failures (24h)"
          value={data?.audit_failures_24h ?? 0}
          sub={`${data?.rate_limited_24h ?? 0} rate-limited`}
          alert={(data?.audit_failures_24h ?? 0) > 0}
        />
        <Stat label="Stripe events (7d)" value={data?.webhooks_7d ?? 0} sub="Webhook deliveries processed" />
        <Stat label="SSO integrations" value={data?.sso_integrations ?? 0} sub="OIDC configs across orgs" />
      </section>

      <div className="pt-grid">
        <section className="pt-panel">
          <div className="pt-panel-head">
            <h2>Top API keys</h2>
            <Link to="/api-keys">Manage keys →</Link>
          </div>
          {data && data.top_keys.length > 0 ? (
            <table className="pt-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Owner</th>
                  <th>Type</th>
                  <th className="right">Calls 24h</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                {data.top_keys.map((key) => (
                  <tr key={key.id}>
                    <td>
                      <strong>{key.name}</strong>
                      <br />
                      <code>{key.key_preview}</code>
                    </td>
                    <td>{key.owner_name}</td>
                    <td>
                      <span className={`pt-pill ${key.key_type === "internal" ? "info" : ""}`}>
                        {key.key_type}
                      </span>
                    </td>
                    <td className="right">{key.calls_24h}</td>
                    <td>{fmtDate(key.last_used_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="pt-empty">No active API keys yet.</div>
          )}
        </section>

        <section className="pt-panel">
          <div className="pt-panel-head">
            <h2>Top endpoints (7 days)</h2>
          </div>
          {data && data.top_endpoints.length > 0 ? (
            <table className="pt-table">
              <thead>
                <tr>
                  <th>Path</th>
                  <th className="right">Calls</th>
                  <th className="right">Errors</th>
                </tr>
              </thead>
              <tbody>
                {data.top_endpoints.map((ep) => (
                  <tr key={ep.path}>
                    <td><code>{ep.path}</code></td>
                    <td className="right">{ep.calls}</td>
                    <td className="right">
                      <span className={ep.errors > 0 ? "pt-pill error" : "pt-pill ok"}>
                        {ep.errors}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="pt-empty">No API key traffic recorded.</div>
          )}
        </section>
      </div>

      <section className="pt-panel">
        <div className="pt-panel-head">
          <h2>Recent API key activity</h2>
        </div>
        {data && data.recent_audit.length > 0 ? (
          <table className="pt-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Key</th>
                <th>Request</th>
                <th>Status</th>
                <th>Outcome</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {data.recent_audit.map((row) => (
                <tr key={row.id}>
                  <td>{fmtDate(row.created_at)}</td>
                  <td>
                    {row.key_name ?? "—"}
                    {row.key_preview && (
                      <>
                        <br />
                        <code>{row.key_preview}</code>
                      </>
                    )}
                  </td>
                  <td>
                    <code>{row.method} {row.path}</code>
                  </td>
                  <td>
                    <span className={`pt-pill ${statusClass(row.status_code, row.outcome)}`}>
                      {row.status_code}
                    </span>
                  </td>
                  <td>
                    <span className={`pt-pill ${row.outcome}`}>{row.outcome}</span>
                  </td>
                  <td>{row.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="pt-empty">No API key requests audited yet.</div>
        )}
      </section>
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
