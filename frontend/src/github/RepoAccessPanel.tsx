import { useCallback, useEffect, useState } from "react";
import {
  listOrganizationMembers,
  listPlatformMembers,
  type Member,
} from "../api/rbac";
import {
  getRepoAccess,
  removeRepoAccess,
  setRepoAccess,
  type RepoAccessResponse,
  type RepoAccessRow,
} from "../api/repoAccess";
import { useAuth } from "../auth/useAuth";
import "./repoAccess.css";

type Level = "read" | "write";

// These roles reach every repository without a grant, and guests never can, so
// granting any of them would change nothing. Matches the server's gates.
const NOT_GRANTABLE = new Set(["owner", "super_admin", "admin", "guest"]);

// Adding a member grants Wayve dashboard visibility and, best-effort, adds them
// as a GitHub collaborator where the token has admin on the repo.
export default function RepoAccessPanel({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  const { user } = useAuth();
  const organizationId = user?.organization_id ?? null;
  const isPersonal = user?.scope === "personal";
  const isPlatform = user?.scope === "platform";
  const [members, setMembers] = useState<Member[]>([]);
  const [addMember, setAddMember] = useState("");
  const [data, setData] = useState<RepoAccessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addLogin, setAddLogin] = useState("");
  const [addLevel, setAddLevel] = useState<Level>("read");

  const load = useCallback(() => {
    setError(null);
    getRepoAccess(owner, repo)
      .then(setData)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load access")
      );
  }, [owner, repo]);

  // Deferred to a microtask so the effect body doesn't synchronously setState,
  // which React 19 flags as a cascading render.
  useEffect(() => {
    const timer = window.setTimeout(() => load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const canManage = data?.can_manage ?? false;

  // Without the list, the GitHub username form below still works.
  useEffect(() => {
    if (!canManage) return;
    const rows = isPlatform
      ? listPlatformMembers()
      : organizationId !== null
        ? listOrganizationMembers(organizationId)
        : null;
    void rows?.then(setMembers).catch(() => {});
  }, [canManage, isPlatform, organizationId]);

  const withDashboardAccess = new Set(
    (data?.rows ?? []).filter((r) => r.in_dashboard).map((r) => r.user_id)
  );
  const grantable = members.filter(
    (m) => !NOT_GRANTABLE.has(m.role) && !withDashboardAccess.has(m.user_id)
  );

  const apply = async (fn: () => Promise<{ note?: string }>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fn();
      if (res.note) setMessage(res.note);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const login = addLogin.trim();
    if (!login) return;
    void apply(async () => {
      const res = await setRepoAccess(owner, repo, {
        github_login: login,
        level: addLevel,
      });
      setAddLogin("");
      return res;
    });
  };

  const addSelectedMember = () => {
    const userId = Number(addMember);
    if (!userId) return;
    void apply(async () => {
      const res = await setRepoAccess(owner, repo, {
        user_id: userId,
        level: addLevel,
      });
      setAddMember("");
      return res;
    });
  };

  const changeLevel = (row: RepoAccessRow, level: Level) =>
    void apply(() =>
      setRepoAccess(owner, repo, {
        user_id: row.user_id ?? undefined,
        github_login: row.github_login ?? undefined,
        level,
      })
    );

  const remove = (row: RepoAccessRow) =>
    void apply(() =>
      removeRepoAccess(owner, repo, {
        user_id: row.user_id ?? undefined,
        login: row.github_login ?? undefined,
      })
    );

  if (error && !data) {
    return <p className="repo-access-error">{error}</p>;
  }
  if (!data) {
    return <p className="repo-access-muted">Loading access…</p>;
  }

  return (
    <div className="repo-access">
      <h2 className="repo-access-title">Repository access</h2>
      <p className="repo-access-sub">
        Who can access <strong>{data.repo}</strong>. Levels come from GitHub;
        adding a member also shows the repo in their Wayve dashboard.
      </p>

      {!data.github_readable && (
        <p className="repo-access-hint">
          Couldn't read collaborators from GitHub — showing Wayve dashboard
          grants only.
        </p>
      )}

      {!isPersonal && (
        <p className="repo-access-muted">
          Owners and admins always have access. Everyone else sees only the
          repositories granted to them here.
        </p>
      )}
      {isPersonal && (
        <p className="repo-access-muted">
          Personal repositories aren&apos;t shared inside Wayve: adding someone
          makes them a collaborator on GitHub.
        </p>
      )}

      {canManage && grantable.length > 0 && (
        <div className="repo-access-add">
          <select
            className="repo-access-select repo-access-member"
            aria-label="Member"
            value={addMember}
            onChange={(e) => setAddMember(e.target.value)}
          >
            <option value="">Choose a member…</option>
            {grantable.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.username ? `${m.username} (${m.email})` : m.email}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="repo-access-btn repo-access-btn--primary"
            onClick={addSelectedMember}
            disabled={busy || !addMember}
          >
            {busy ? "Working…" : "Add member"}
          </button>
        </div>
      )}

      {canManage && (
        <div className="repo-access-add">
          <input
            className="repo-access-input"
            placeholder="GitHub username"
            aria-label="GitHub username"
            value={addLogin}
            onChange={(e) => setAddLogin(e.target.value)}
            autoComplete="off"
          />
          <select
            className="repo-access-select"
            aria-label="Access level"
            value={addLevel}
            onChange={(e) => setAddLevel(e.target.value as Level)}
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
          </select>
          <button
            type="button"
            className="repo-access-btn repo-access-btn--primary"
            onClick={add}
            disabled={busy || !addLogin.trim()}
          >
            {busy ? "Working…" : "Add access"}
          </button>
        </div>
      )}

      {message && <p className="repo-access-note">{message}</p>}
      {error && <p className="repo-access-error">{error}</p>}

      {data.rows.length === 0 ? (
        <p className="repo-access-muted">No one has access yet.</p>
      ) : (
        <ul className="repo-access-list">
          {data.rows.map((row, i) => (
            <li
              key={`${row.user_id ?? row.github_login ?? i}`}
              className="repo-access-item"
            >
              <div className="repo-access-who">
                <span className="repo-access-name">
                  {row.email ?? row.github_login ?? "Unknown"}
                </span>
                <span className="repo-access-meta">
                  {row.github_login && <span>@{row.github_login}</span>}
                  {!row.is_member && (
                    <span className="repo-access-tag">GitHub only</span>
                  )}
                  {row.in_dashboard && (
                    <span className="repo-access-tag repo-access-tag--ok">
                      In dashboard
                    </span>
                  )}
                </span>
              </div>

              <div className="repo-access-controls">
                <span
                  className={`repo-access-level repo-access-level--${row.level}`}
                >
                  {row.level}
                </span>
                {canManage && row.level !== "admin" && (
                  <>
                    <select
                      className="repo-access-select repo-access-select--sm"
                      value={row.level}
                      onChange={(e) =>
                        changeLevel(row, e.target.value as Level)
                      }
                      disabled={busy}
                      aria-label="Change level"
                    >
                      <option value="read">Read</option>
                      <option value="write">Write</option>
                    </select>
                    <button
                      type="button"
                      className="repo-access-btn repo-access-btn--danger"
                      onClick={() => remove(row)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
