import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  deletePersonalUser,
  getUsersSummary,
  listPlatformUsers,
  type UsersSummary,
  type PlatformUserRow,
} from "../api/platformTeam";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { formatBytes } from "../utils/bytes";
import { fmtDate, fmtDateTime } from "../utils/datetime";
import ConfirmDeleteDialog from "./ConfirmDeleteDialog";
import "./admin-ui.css";
import "./platformAdmin.css";

const PAGE_SIZE = 50;

const PROVIDER_LABELS: Record<string, string> = {
  local: "Email",
  google: "Google",
  github: "GitHub",
  sso: "SSO",
};

function displayName(u: PlatformUserRow): string | null {
  const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return full || u.username || null;
}

// Platform admin "Personal accounts" page: every personal (non-org) account
// with its details, plus a type-to-confirm permanent delete for staff holding
// members:manage. The backend re-checks scope + permission on every call.
export default function PlatformUsers() {
  const { user } = useAuth();
  const canDelete = hasPermission(user, "members:manage");

  const [data, setData] = useState<UsersSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [users, setUsers] = useState<PlatformUserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState("");
  const [search, setSearch] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<PlatformUserRow | null>(
    null
  );
  const [notice, setNotice] = useState("");

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

  // Debounced on the search box so typing doesn't fire a request per keystroke.
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

  // Throws on failure so ConfirmDeleteDialog shows the server's message.
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    await deletePersonalUser(target.id);
    setUsers((prev) => prev.filter((u) => u.id !== target.id));
    setData((prev) =>
      prev ? { ...prev, users_total: Math.max(0, prev.users_total - 1) } : prev
    );
    setPendingDelete(null);
    setNotice(`Deleted ${target.email}.`);
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
          <h1>Personal accounts</h1>
          <p>Every personal account registered on the platform.</p>
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
          <h2>Personal accounts</h2>
          <input
            type="search"
            className="platform-users-search"
            placeholder="Search by email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search personal accounts by email"
          />
        </div>

        {notice && (
          <div
            className="platform-admin-success platform-users-notice"
            role="status"
          >
            {notice}
          </div>
        )}

        {usersLoading ? (
          <div className="platform-admin-empty">Loading users…</div>
        ) : usersError ? (
          <div className="platform-admin-error">{usersError}</div>
        ) : users.length === 0 ? (
          <div className="platform-admin-empty">
            No personal accounts found.
          </div>
        ) : (
          <>
            <div className="platform-users-scroll">
              <table className="platform-users-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Sign-in</th>
                    <th>Plan</th>
                    <th className="platform-users-num">Mailboxes</th>
                    <th>Joined</th>
                    <th>Last seen</th>
                    <th className="platform-users-num">Storage</th>
                    {canDelete && <th aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const name = displayName(u);
                    return (
                      <tr key={u.id}>
                        <td>
                          <div className="platform-users-account">
                            <span className="platform-users-email">
                              {u.email}
                            </span>
                            {name && (
                              <span className="platform-users-name">
                                {name}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="platform-users-nowrap">
                          {PROVIDER_LABELS[u.auth_provider] ??
                            (u.auth_provider || "—")}
                          {!u.email_verified && (
                            <span className="platform-users-badge">
                              Unverified
                            </span>
                          )}
                        </td>
                        <td>{u.plan_name ?? "Free"}</td>
                        <td className="platform-users-num">
                          {u.mailbox_count}
                        </td>
                        <td className="platform-users-nowrap">
                          {fmtDate(u.created_at)}
                        </td>
                        <td className="platform-users-nowrap">
                          {u.last_seen ? fmtDateTime(u.last_seen) : "Never"}
                        </td>
                        <td className="platform-users-num">
                          {formatBytes(u.storage_bytes)}
                        </td>
                        {canDelete && (
                          <td>
                            <button
                              type="button"
                              className="danger-outline-btn"
                              onClick={() => {
                                setNotice("");
                                setPendingDelete(u);
                              }}
                              aria-label={`Delete account ${u.email}`}
                            >
                              Delete
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

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

      {pendingDelete && (
        <ConfirmDeleteDialog
          title="Delete personal account?"
          confirmText={pendingDelete.email}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        >
          <p>
            This permanently deletes <strong>{pendingDelete.email}</strong> and
            all of its data: mail, drive files, chats, notes and tasks.
          </p>
          <p>
            Any active subscription is cancelled immediately. This cannot be
            undone.
          </p>
        </ConfirmDeleteDialog>
      )}
    </div>
  );
}
