import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getUsersSummary,
  listPlatformUsers,
  type UsersSummary,
  type PlatformUserRow,
} from "../api/platformTeam";
import { formatBytes } from "../utils/bytes";
import "./admin-ui.css";
import "./platformAdmin.css";

const PAGE_SIZE = 50;

export default function PlatformUsers() {
  const [data, setData] = useState<UsersSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Per-user table (personal users): email + memory used.
  const [users, setUsers] = useState<PlatformUserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState("");
  const [search, setSearch] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let alive = true;

    getUsersSummary()
      .then((summary) => {
        if (alive) setData(summary);
      })
      .catch((err) => {
        if (alive)
          setError(err instanceof Error ? err.message : "Failed to load users");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  // Load (or reload) the personal-users table. Debounced on the search box so
  // typing doesn't fire a request per keystroke.
  useEffect(() => {
    let alive = true;
    setUsersLoading(true);
    setUsersError("");

    const timer = window.setTimeout(() => {
      listPlatformUsers({
        accountType: "personal",
        q: search,
        limit: PAGE_SIZE,
      })
        .then((res) => {
          if (!alive) return;
          setUsers(res.users);
          setHasMore(res.users.length === PAGE_SIZE);
        })
        .catch((err) => {
          if (alive)
            setUsersError(
              err instanceof Error ? err.message : "Failed to load users"
            );
        })
        .finally(() => {
          if (alive) setUsersLoading(false);
        });
    }, 250);

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [search]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await listPlatformUsers({
        accountType: "personal",
        q: search,
        limit: PAGE_SIZE,
        offset: users.length,
      });
      setUsers((prev) => [...prev, ...res.users]);
      setHasMore(res.users.length === PAGE_SIZE);
    } catch (err) {
      setUsersError(
        err instanceof Error ? err.message : "Failed to load more users"
      );
    } finally {
      setLoadingMore(false);
    }
  };

  const stats = data
    ? [
        { label: "Total users", value: data.users_total.toLocaleString() },
        {
          label: "New (last month)",
          value: data.users_new_1m.toLocaleString(),
        },
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
          <p>Personal user totals, growth and storage usage.</p>
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

      <section className="platform-admin-panel u-panel">
        <div className="platform-users-toolbar">
          <h2>Personal users</h2>
          <input
            type="search"
            className="platform-users-search"
            placeholder="Search by email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search personal users by email"
          />
        </div>

        {usersLoading ? (
          <div className="platform-admin-empty">Loading users…</div>
        ) : usersError ? (
          <div className="platform-admin-error">{usersError}</div>
        ) : users.length === 0 ? (
          <div className="platform-admin-empty">No personal users found.</div>
        ) : (
          <>
            <table className="platform-users-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th className="platform-users-num">Memory used</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td className="platform-users-num">
                      {formatBytes(u.storage_bytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {hasMore && (
              <div className="platform-users-more">
                <button
                  type="button"
                  className="u-btn-secondary"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
