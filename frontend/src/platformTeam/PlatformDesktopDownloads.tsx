import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  getDesktopDownloadStats,
  type DesktopDownloadStats,
} from "../api/desktopDownloads";
import { fmtDateTime } from "../utils/datetime";
import "./platformTeam.css";

const BUILD_LABELS: Record<string, string> = {
  "mac-arm64": "macOS · Apple Silicon",
  "mac-x64": "macOS · Intel",
};

function buildLabel(build: string): string {
  return BUILD_LABELS[build] ?? build;
}

function locationLabel(r: {
  city: string | null;
  region: string | null;
  country: string | null;
}): string {
  return [r.city, r.region, r.country].filter(Boolean).join(", ");
}

// Clicks on the site's Download App menu, counted server-side as each one
// redirects to the installer. The backend requires platform scope + audit:read.
export default function PlatformDesktopDownloads() {
  const { user } = useAuth();
  const canView =
    user?.scope === "platform" && hasPermission(user, "audit:read");

  const [data, setData] = useState<DesktopDownloadStats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!canView) return;
    let alive = true;
    getDesktopDownloadStats()
      .then((stats) => {
        if (alive) setData(stats);
      })
      .catch((err: unknown) => {
        if (alive)
          setError(
            err instanceof Error ? err.message : "Failed to load downloads"
          );
      });
    return () => {
      alive = false;
    };
  }, [canView]);

  if (!canView)
    return (
      <div style={{ padding: 16, color: "#6b7280" }}>
        You don't have access to this data.
      </div>
    );
  if (error) return <div className="pt-banner">{error}</div>;
  if (!data) return <div className="pt-empty">Loading…</div>;

  return (
    <div className="pt-page">
      <section className="pt-stats">
        <Stat label="Downloads" value={data.total} sub="All time" />
        <Stat
          label="Unique IPs"
          value={data.unique_ips}
          sub="Approximate people"
        />
        <Stat label="Last 30 days" value={data.last_30_days} />
        {data.by_build.map((b) => (
          <Stat key={b.build} label={buildLabel(b.build)} value={b.count} />
        ))}
      </section>

      <div className="pt-grid">
        <section className="pt-panel">
          <div className="pt-panel-head">
            <h2>Downloads by location</h2>
            <span className="pt-stat-sub">Top 100</span>
          </div>
          {data.by_location.length > 0 ? (
            <table className="pt-table">
              <thead>
                <tr>
                  <th>Location</th>
                  <th className="right">Downloads</th>
                </tr>
              </thead>
              <tbody>
                {data.by_location.map((r) => {
                  const loc = locationLabel(r);
                  return (
                    <tr key={`${r.country}|${r.region}|${r.city}`}>
                      <td>
                        {loc || <span className="pt-empty-cell">Unknown</span>}
                      </td>
                      <td className="right">{r.count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="pt-empty">No downloads recorded yet.</div>
          )}
        </section>

        <section className="pt-panel">
          <div className="pt-panel-head">
            <h2>Recent downloads</h2>
            <span className="pt-stat-sub">Latest {data.recent.length}</span>
          </div>
          {data.recent.length > 0 ? (
            <div className="pt-table-scroll">
              <table className="pt-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Build</th>
                    <th>Location</th>
                    <th>User</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r) => {
                    const loc = locationLabel(r);
                    return (
                      <tr key={r.id}>
                        <td>{fmtDateTime(r.created_at)}</td>
                        <td>{buildLabel(r.build)}</td>
                        <td>
                          {loc || <span className="pt-empty-cell">-</span>}
                        </td>
                        <td>
                          {r.user_email ?? (
                            <span className="pt-empty-cell">Anonymous</span>
                          )}
                        </td>
                        <td>
                          {r.ip ?? <span className="pt-empty-cell">-</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="pt-empty">No downloads recorded yet.</div>
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
}: {
  label: string;
  value: number;
  sub?: string;
}) {
  return (
    <div className="pt-stat">
      <span className="pt-stat-label">{label}</span>
      <span className="pt-stat-value">{value}</span>
      {sub && <span className="pt-stat-sub">{sub}</span>}
    </div>
  );
}
