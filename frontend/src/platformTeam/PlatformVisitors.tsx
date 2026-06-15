import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { listVisits, type VisitRow } from "../api/visits";
import { fmtDateTime } from "../utils/datetime";
import { useResizableColumns } from "./useResizableColumns";
import "./platformTeam.css";

// Drag-resizable columns, in render order. Persisted under VISITORS_COL_WIDTHS.
const VISITOR_COLUMNS = [
  { key: "when", label: "When", width: 150, min: 110 },
  { key: "visitor", label: "Visitor", width: 200, min: 100 },
  { key: "ip", label: "IP", width: 130, min: 90 },
  { key: "location", label: "Location", width: 180, min: 110 },
  { key: "device", label: "Device", width: 100, min: 70 },
  { key: "browser", label: "Browser", width: 100, min: 70 },
  { key: "referrer", label: "Referrer", width: 240, min: 120 },
] as const;

const VISITORS_COL_WIDTHS_KEY = "rwayve.platformVisitors.colWidths";

// Device / browser parsed from the raw User-Agent the backend stored. Cheap
// substring matching — good enough for an at-a-glance traffic view.
function parseDevice(ua: string | null): string {
  if (!ua) return "—";
  const s = ua.toLowerCase();
  if (s.includes("iphone")) return "iPhone";
  if (s.includes("ipad")) return "iPad";
  if (s.includes("android")) return "Android";
  if (s.includes("macintosh") || s.includes("mac os")) return "Mac";
  if (s.includes("windows")) return "Windows";
  if (s.includes("linux")) return "Linux";
  return "Other";
}

function parseBrowser(ua: string | null): string {
  if (!ua) return "—";
  const s = ua.toLowerCase();
  if (s.includes("edg/")) return "Edge";
  if (s.includes("opr/") || s.includes("opera")) return "Opera";
  if (s.includes("firefox/")) return "Firefox";
  if (s.includes("chrome/")) return "Chrome";
  if (s.includes("safari/")) return "Safari";
  return "Other";
}

// Everyone who opened the public site (incl. anonymous visitors) — from the
// page_visits table. Owner-only; the backend additionally requires platform
// scope + audit:read.
export default function PlatformVisitors() {
  const { user } = useAuth();
  const canView =
    user?.scope === "platform" && user?.effective_role === "owner";

  const [rows, setRows] = useState<VisitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  const { colWidths, totalWidth, startResize } = useResizableColumns(
    VISITOR_COLUMNS,
    VISITORS_COL_WIDTHS_KEY
  );

  const load = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }
    setError("");
    setLoading(true);
    try {
      setRows(await listVisits({ limit: 500 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load visitors");
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => {
    const uniqueIps = new Set(rows.map((r) => r.ip).filter(Boolean)).size;
    const signedIn = rows.filter((r) => r.user_id !== null).length;
    return {
      total: rows.length,
      uniqueIps,
      signedIn,
      anon: rows.length - signedIn,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [
        r.user_email,
        r.ip,
        r.city,
        r.region,
        r.country,
        r.path,
        r.referrer,
        parseDevice(r.user_agent),
        parseBrowser(r.user_agent),
        r.user_agent,
      ].some((v) => (v ?? "").toLowerCase().includes(q))
    );
  }, [rows, search]);

  if (!canView) return <Navigate to="/home" replace />;

  return (
    <div className="pt-page">
      <header className="pt-header">
        <h1>Visitors</h1>
      </header>

      {error && <div className="pt-banner">{error}</div>}

      <section className="pt-panel">
        <div className="pt-panel-head">
          <h2>
            Site visits{" "}
            <span style={{ opacity: 0.85 }}>
              · {summary.total} visits · {summary.uniqueIps} unique IPs ·{" "}
              {summary.signedIn} signed-in · {summary.anon} anonymous
            </span>
          </h2>
          <input
            type="search"
            className="pt-filter-select"
            placeholder="Search IP, page, device, user…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search visitors"
          />
        </div>

        {loading ? (
          <div className="pt-empty">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="pt-empty">
            {rows.length === 0
              ? "No visits recorded yet."
              : "No matches for that search."}
          </div>
        ) : (
          <div className="pt-table-scroll">
            <table
              className="pt-table"
              style={{ tableLayout: "fixed", width: `${totalWidth}px` }}
            >
              <colgroup>
                {VISITOR_COLUMNS.map((c) => (
                  <col key={c.key} style={{ width: `${colWidths[c.key]}px` }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {VISITOR_COLUMNS.map((c) => (
                    <th key={c.key} className="pt-th-resizable">
                      {c.label}
                      <span
                        className="pt-col-resize-handle"
                        onMouseDown={startResize(c.key, c.min)}
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${c.label} column`}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const location = [r.city, r.region, r.country]
                    .filter(Boolean)
                    .join(", ");
                  return (
                    <tr key={r.id}>
                      <td>{fmtDateTime(r.created_at)}</td>
                      <td>
                        {r.user_email ?? (
                          <span className="pt-empty-cell">Anonymous</span>
                        )}
                      </td>
                      <td>
                        {r.ip ?? <span className="pt-empty-cell">-</span>}
                      </td>
                      <td className="pt-loc" title={location}>
                        {location || <span className="pt-empty-cell">-</span>}
                      </td>
                      <td>{parseDevice(r.user_agent)}</td>
                      <td>{parseBrowser(r.user_agent)}</td>
                      <td className="pt-details" title={r.referrer ?? ""}>
                        {r.referrer || <span className="pt-empty-cell">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
