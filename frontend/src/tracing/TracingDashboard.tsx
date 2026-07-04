import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useAuth } from "../auth/useAuth";
import { getTracingOverview, type TracingOverview } from "../api/tracing";
import { fmtDateTime } from "../utils/datetime";
import "./tracingDashboard.css";

const LEVEL_COLORS: Record<string, string> = {
  INFO: "#2563eb",
  WARN: "#d97706",
  ERROR: "#dc2626",
  DEBUG: "#6b7280",
  other: "#9ca3af",
};

const LEVEL_KEYS = ["ERROR", "WARN", "INFO", "DEBUG", "other"] as const;

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function TracingDashboard({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const { user } = useAuth();
  const isOwner =
    user?.scope === "platform" && user?.effective_role === "owner";

  const [data, setData] = useState<TracingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [levelFilter, setLevelFilter] = useState("");

  const load = useCallback(async () => {
    if (!isOwner) return;
    setError("");
    setLoading(true);
    try {
      setData(await getTracingOverview(levelFilter || undefined));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load tracing data"
      );
    } finally {
      setLoading(false);
    }
  }, [isOwner, levelFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const timeline = useMemo(
    () => (data?.timeline ?? []).map((p) => ({ ...p, label: hhmm(p.t) })),
    [data]
  );

  if (!isOwner)
    return embedded ? (
      <div style={{ padding: 16, color: "#6b7280" }}>
        You don't have access to this log.
      </div>
    ) : (
      <Navigate to="/home" replace />
    );

  const levels = data?.levels ?? {};

  return (
    <div className="trace-page">
      <header className="trace-header">
        <div>
          <h1>Tracing dashboard</h1>
          <p>Live view of the server tracing log (logs/tracing.log).</p>
        </div>
        <div className="trace-controls">
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            aria-label="Filter by level"
          >
            <option value="">All levels</option>
            <option value="ERROR">Error</option>
            <option value="WARN">Warn</option>
            <option value="INFO">Info</option>
            <option value="DEBUG">Debug</option>
          </select>
          <button type="button" onClick={() => void load()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>

      {error && <div className="trace-banner">{error}</div>}

      <div className="trace-stats">
        <div className="trace-stat">
          <span className="trace-stat-label">Events (recent)</span>
          <span className="trace-stat-value">{data?.total ?? 0}</span>
        </div>
        <div className="trace-stat error">
          <span className="trace-stat-label">Errors</span>
          <span className="trace-stat-value">{levels.ERROR ?? 0}</span>
        </div>
        <div className="trace-stat warn">
          <span className="trace-stat-label">Warnings</span>
          <span className="trace-stat-value">{levels.WARN ?? 0}</span>
        </div>
        <div className="trace-stat info">
          <span className="trace-stat-label">Info</span>
          <span className="trace-stat-value">{levels.INFO ?? 0}</span>
        </div>
      </div>

      <section className="trace-panel">
        <h2>Log volume over time</h2>
        {timeline.length === 0 ? (
          <div className="trace-empty">
            No timestamped events in the recent log window.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart
              data={timeline}
              margin={{ top: 8, right: 16, bottom: 0, left: -16 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="label" fontSize={11} minTickGap={24} />
              <YAxis fontSize={11} allowDecimals={false} />
              <Tooltip />
              <Legend />
              {LEVEL_KEYS.map((k) => (
                <Area
                  key={k}
                  type="monotone"
                  dataKey={k}
                  stackId="1"
                  stroke={LEVEL_COLORS[k]}
                  fill={LEVEL_COLORS[k]}
                  fillOpacity={0.5}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </section>

      <section className="trace-panel">
        <h2>Busiest targets</h2>
        {(data?.top_targets ?? []).length === 0 ? (
          <div className="trace-empty">No data.</div>
        ) : (
          <ResponsiveContainer
            width="100%"
            height={Math.max(160, (data?.top_targets.length ?? 0) * 26)}
          >
            <BarChart
              layout="vertical"
              data={data?.top_targets ?? []}
              margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#eee"
                horizontal={false}
              />
              <XAxis type="number" fontSize={11} allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="target"
                width={180}
                fontSize={11}
              />
              <Tooltip />
              <Bar dataKey="count" fill="#2563eb" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </section>

      <section className="trace-panel">
        <h2>Slowest spans</h2>
        {(data?.slowest ?? []).length === 0 ? (
          <div className="trace-empty">
            No span timings in the recent window.
          </div>
        ) : (
          <div className="trace-table-wrap trace-table-scroll">
            <table className="trace-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Span</th>
                  <th>Target</th>
                  <th className="right">Busy (ms)</th>
                </tr>
              </thead>
              <tbody>
                {data!.slowest.map((s, i) => (
                  <tr key={`${s.ts}-${i}`}>
                    <td>{fmtDateTime(s.ts)}</td>
                    <td>{s.span ?? s.message ?? "—"}</td>
                    <td>{s.target || "—"}</td>
                    <td className="right">{s.busy_ms.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="trace-panel">
        <h2>Recent entries</h2>
        {(data?.recent ?? []).length === 0 ? (
          <div className="trace-empty">No recent entries.</div>
        ) : (
          <div className="trace-table-wrap trace-table-scroll">
            <table className="trace-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Level</th>
                  <th>Target</th>
                  <th>Message / span</th>
                </tr>
              </thead>
              <tbody>
                {data!.recent.map((r, i) => (
                  <tr key={`${r.ts}-${i}`}>
                    <td>{fmtDateTime(r.ts)}</td>
                    <td>
                      <span
                        className="trace-level"
                        style={{ color: LEVEL_COLORS[r.level] ?? "#6b7280" }}
                      >
                        {r.level}
                      </span>
                    </td>
                    <td>{r.target || "—"}</td>
                    <td>{r.message ?? r.span ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
