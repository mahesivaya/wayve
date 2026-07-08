import { useCallback, useEffect, useState } from "react";
import {
  getRepoAccess,
  removeRepoAccess,
  setRepoAccess,
  type RepoAccessResponse,
  type RepoAccessRow,
} from "../api/repoAccess";
import "./repoAccess.css";

type Level = "read" | "write";

// Per-repo access panel: shows who can access this repo and at what level
// (GitHub's live level when available), and lets an admin add/remove members.
// Adding a member grants Wayve dashboard visibility and best-effort-adds them as
// a GitHub collaborator (where the token has admin on the repo).
export default function RepoAccessPanel({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
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

  // Deferred to a microtask so the effect body doesn't synchronously setState
  // (React 19 cascading-render rule) — same pattern as Tasks.tsx / AuditSecurity.
  useEffect(() => {
    const timer = window.setTimeout(() => load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const canManage = data?.can_manage ?? false;

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

      {canManage && (
        <div className="repo-access-add">
          <input
            className="repo-access-input"
            placeholder="GitHub username"
            value={addLogin}
            onChange={(e) => setAddLogin(e.target.value)}
            autoComplete="off"
          />
          <select
            className="repo-access-select"
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
                <span className={`repo-access-level repo-access-level--${row.level}`}>
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
