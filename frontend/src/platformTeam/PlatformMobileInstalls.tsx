import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  getMobileInstallStats,
  type MobileInstallStats,
} from "../api/mobileInstalls";
import { fmtDateTime } from "../utils/datetime";
import "./platformTeam.css";

const CHANNEL_LABELS: Record<string, string> = {
  app_store: "App Store",
  testflight: "TestFlight",
  debug: "Developer build",
};

function channelLabel(channel: string | null): string {
  return channel ? (CHANNEL_LABELS[channel] ?? channel) : "Unknown";
}

// The backend only returns channels that have installs; keep App Store and
// TestFlight side by side even while one of them is still at 0.
function channelCounts(
  byChannel: { key: string | null; count: number }[]
): { key: string | null; count: number }[] {
  const known = ["app_store", "testflight"].map((key) => ({
    key,
    count: byChannel.find((c) => c.key === key)?.count ?? 0,
  }));
  const other = byChannel.filter(
    (c) => c.key !== "app_store" && c.key !== "testflight"
  );
  return [...known, ...other];
}

function locationLabel(r: {
  city: string | null;
  region: string | null;
  country: string | null;
}): string {
  return [r.city, r.region, r.country].filter(Boolean).join(", ");
}

// Installs of the iPhone app, which reports itself on every launch. The backend
// requires platform scope + audit:read.
export default function PlatformMobileInstalls() {
  const { user } = useAuth();
  const canView =
    user?.scope === "platform" && hasPermission(user, "audit:read");

  const [data, setData] = useState<MobileInstallStats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!canView) return;
    let alive = true;
    getMobileInstallStats()
      .then((stats) => {
        if (alive) setData(stats);
      })
      .catch((err: unknown) => {
        if (alive)
          setError(
            err instanceof Error ? err.message : "Failed to load installs"
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
        <Stat label="Installs" value={data.total} sub="All time" />
        <Stat
          label="Active"
          value={data.active_30_days}
          sub="Opened in the last 30 days"
        />
        <Stat label="New" value={data.new_30_days} sub="Last 30 days" />
        {channelCounts(data.by_channel).map((c) => (
          <Stat
            key={c.key ?? "unknown"}
            label={channelLabel(c.key)}
            value={c.count}
          />
        ))}
      </section>

      <div className="pt-grid">
        <section className="pt-panel">
          <div className="pt-panel-head">
            <h2>Installs by version</h2>
          </div>
          {data.by_version.length > 0 ? (
            <table className="pt-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th className="right">Installs</th>
                </tr>
              </thead>
              <tbody>
                {data.by_version.map((r) => (
                  <tr key={r.key ?? "unknown"}>
                    <td>
                      {r.key ?? <span className="pt-empty-cell">Unknown</span>}
                    </td>
                    <td className="right">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="pt-empty">No installs recorded yet.</div>
          )}
        </section>

        <section className="pt-panel">
          <div className="pt-panel-head">
            <h2>Installs by location</h2>
            <span className="pt-stat-sub">Top 100</span>
          </div>
          {data.by_location.length > 0 ? (
            <table className="pt-table">
              <thead>
                <tr>
                  <th>Location</th>
                  <th className="right">Installs</th>
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
            <div className="pt-empty">No installs recorded yet.</div>
          )}
        </section>

        <section className="pt-panel">
          <div className="pt-panel-head">
            <h2>Recent installs</h2>
            <span className="pt-stat-sub">Latest {data.recent.length}</span>
          </div>
          {data.recent.length > 0 ? (
            <div className="pt-table-scroll">
              <table className="pt-table">
                <thead>
                  <tr>
                    <th>Installed</th>
                    <th>Last opened</th>
                    <th>Source</th>
                    <th>Version</th>
                    <th>Device</th>
                    <th>Location</th>
                    <th>User</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r) => {
                    const loc = locationLabel(r);
                    const device = [
                      r.device_model,
                      r.os_version && `iOS ${r.os_version}`,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <tr key={r.id}>
                        <td>{fmtDateTime(r.first_seen_at)}</td>
                        <td>{fmtDateTime(r.last_seen_at)}</td>
                        <td>{channelLabel(r.channel)}</td>
                        <td>
                          {r.app_version ? (
                            r.build ? (
                              `${r.app_version} (${r.build})`
                            ) : (
                              r.app_version
                            )
                          ) : (
                            <span className="pt-empty-cell">-</span>
                          )}
                        </td>
                        <td>
                          {device || <span className="pt-empty-cell">-</span>}
                        </td>
                        <td>
                          {loc || <span className="pt-empty-cell">-</span>}
                        </td>
                        <td>
                          {r.user_email ?? (
                            <span className="pt-empty-cell">Not signed in</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="pt-empty">No installs recorded yet.</div>
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
