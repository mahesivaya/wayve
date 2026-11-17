import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { getVisibleProjects, type GithubRepo } from "../api/github";
import {
  getRepoAccess,
  getRepoSummary,
  setRepoSummary,
  type RepoAccessRow,
} from "../api/repoAccess";
import { hasPermission } from "../auth/permissions";
import { useAuth } from "../auth/useAuth";
import Avatar from "../components/Avatar";
import { getApiBase } from "../config/env";
import RepoAccessPanel from "../github/RepoAccessPanel";
import "./projects.css";

// Project detail page, for a project's linked GitHub repository: its name and
// summary, the people with access, and a link into the Code Repo viewer. The
// repo is passed via router state for an instant render, and re-resolved from
// /projects/visible on a cold/direct load.
export default function ProjectDetail() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // Owners and admins (members:manage, which follows admin mode) get the
  // access panel, where they add and remove the project's members. Everyone
  // else gets the read-only list. The backend enforces the same permission.
  const canManageMembers = hasPermission(user, "members:manage");
  const location = useLocation();
  const { owner = "", repo: repoName = "" } = useParams<{
    owner: string;
    repo: string;
  }>();

  const preset = (location.state as { repo?: GithubRepo } | null)?.repo ?? null;
  const [repo, setRepo] = useState<GithubRepo | null>(preset);
  // null = still resolving; false = resolved (found or gave up).
  const [resolving, setResolving] = useState(!preset);
  const [notFound, setNotFound] = useState(false);
  // Users with access to this project (Wayve members + GitHub collaborators).
  // null = still loading; [] = none / not readable.
  const [members, setMembers] = useState<RepoAccessRow[] | null>(null);
  const [membersReadable, setMembersReadable] = useState(true);
  // Wayve-local, editable project summary (separate from the GitHub repo's own
  // description). `summary` is the stored blurb; `canEditSummary` gates the
  // edit affordance; the rest drive the inline editor.
  const [summary, setSummary] = useState("");
  const [canEditSummary, setCanEditSummary] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [savingSummary, setSavingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState("");

  // Resolve the repo when we didn't get it via navigation state (direct URL
  // load / refresh). Fall back to a synthesized stub so the page still renders
  // its name even if the list can't be fetched.
  useEffect(() => {
    if (preset) return;
    let cancelled = false;
    getVisibleProjects()
      .then((data) => {
        if (cancelled) return;
        const match = (data?.repos ?? []).find(
          (r) => r.owner.login === owner && r.name === repoName
        );
        if (match) setRepo(match);
        else setNotFound(true);
      })
      .catch(() => {
        if (cancelled) return;
        // Couldn't list repos (e.g. GitHub token missing) — keep the page usable
        // with what the URL gives us.
        setRepo({
          full_name: `${owner}/${repoName}`,
          name: repoName,
          owner: { login: owner },
          description: null,
          private: false,
          default_branch: "main",
          language: null,
          updated_at: "",
        });
      })
      .finally(() => !cancelled && setResolving(false));
    return () => {
      cancelled = true;
    };
  }, [preset, owner, repoName]);

  // Best-effort enrichments once we know the owner/repo. Failures are silent —
  // the corresponding sections simply stay empty.
  useEffect(() => {
    if (!owner || !repoName) return;
    let cancelled = false;
    // The access panel loads the members itself.
    if (!canManageMembers) {
      getRepoAccess(owner, repoName)
        .then((data) => {
          if (cancelled) return;
          setMembers(Array.isArray(data?.rows) ? data.rows : []);
          setMembersReadable(data?.github_readable ?? true);
        })
        .catch(() => {
          if (cancelled) return;
          setMembers([]);
          setMembersReadable(false);
        });
    }
    getRepoSummary(owner, repoName)
      .then((data) => {
        if (cancelled) return;
        setSummary(data?.summary ?? "");
        setCanEditSummary(Boolean(data?.can_edit));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [owner, repoName, canManageMembers]);

  // The blurb we display: the Wayve summary if set, else the repo's own GitHub
  // description. Editing seeds from whichever is shown.
  const displaySummary = summary || repo?.description || "";

  const startEditSummary = () => {
    setSummaryDraft(displaySummary);
    setSummaryError("");
    setEditingSummary(true);
  };

  // Save is gated on the draft differing from the blurb the editor seeded from,
  // so opening it and closing it can't post a no-op write. Trimmed on both
  // sides because `saveSummary` trims what it sends.
  const summaryDirty = summaryDraft.trim() !== displaySummary.trim();

  const saveSummary = async () => {
    setSavingSummary(true);
    setSummaryError("");
    try {
      const res = await setRepoSummary(owner, repoName, summaryDraft.trim());
      setSummary(res.summary);
      setEditingSummary(false);
    } catch (err) {
      setSummaryError(
        err instanceof Error ? err.message : "Couldn't save the summary"
      );
    } finally {
      setSavingSummary(false);
    }
  };

  if (resolving && !repo) {
    return (
      <div className="projects-page u-page-shell">
        <p className="projects-empty">Loading…</p>
      </div>
    );
  }

  if (notFound || !repo) {
    return (
      <div className="projects-page u-page-shell">
        <button
          type="button"
          className="projects-back"
          onClick={() => navigate("/projects")}
        >
          ← Projects
        </button>
        <p className="projects-empty">That project couldn&apos;t be found.</p>
      </div>
    );
  }

  // The repository's real address, as GitHub reports it for the org's or
  // platform's connected account; built from the names only when the live
  // list couldn't be read.
  const repoUrl =
    repo.html_url ||
    `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(
      repoName
    )}`;

  return (
    <div className="projects-page u-page-shell project-detail-page">
      <main className="project-detail-main">
        <div className="project-detail-heading">
          <span className="project-detail-icon" aria-hidden="true">
            ▣
          </span>
          <h1 className="project-detail-name">{repo.name}</h1>
        </div>
        {editingSummary ? (
          <div className="project-detail-summary-edit">
            <textarea
              className="project-detail-summary-input"
              value={summaryDraft}
              onChange={(e) => setSummaryDraft(e.target.value)}
              placeholder="Add a short summary of this project…"
              rows={3}
              maxLength={2000}
              autoFocus
            />
            {summaryError && (
              <p className="project-detail-summary-error">{summaryError}</p>
            )}
            <div className="project-detail-summary-actions">
              <button
                type="button"
                className="project-detail-summary-save"
                onClick={() => void saveSummary()}
                disabled={savingSummary || !summaryDirty}
                title={summaryDirty ? undefined : "No changes to save"}
              >
                {savingSummary ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="project-detail-summary-cancel"
                onClick={() => setEditingSummary(false)}
                disabled={savingSummary}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="project-detail-summary-row">
            <p
              className={`project-detail-summary${
                displaySummary ? "" : " is-empty"
              }`}
            >
              {displaySummary || "No summary yet."}
            </p>
            {canEditSummary && (
              <button
                type="button"
                className="project-detail-summary-edit-btn"
                onClick={startEditSummary}
              >
                {displaySummary ? "Edit" : "Add summary"}
              </button>
            )}
          </div>
        )}

        {canManageMembers ? (
          <section className="project-detail-section">
            <RepoAccessPanel owner={owner} repo={repoName} />
          </section>
        ) : (
          <section className="project-detail-section">
            <h2 className="project-detail-section-title">
              Members
              {members && members.length > 0 && (
                <span className="project-detail-count">{members.length}</span>
              )}
            </h2>
            {members === null ? (
              <p className="project-detail-muted">Loading members…</p>
            ) : members.length === 0 ? (
              <p className="project-detail-muted">
                {membersReadable
                  ? "No one has access yet."
                  : "Member list unavailable for this repo."}
              </p>
            ) : (
              <ul className="project-detail-members">
                {members.map((m, i) => {
                  const displayName =
                    m.email || m.github_login || "Unknown user";
                  return (
                    <li
                      key={`${m.user_id ?? m.github_login ?? i}`}
                      className="project-detail-member"
                    >
                      <Avatar
                        name={displayName}
                        src={
                          m.user_id != null
                            ? `${getApiBase()}/api/users/${m.user_id}/avatar`
                            : null
                        }
                        size={32}
                      />
                      <span className="project-detail-member-text">
                        <span className="project-detail-member-name">
                          {displayName}
                        </span>
                        <span className="project-detail-member-meta">
                          {m.github_login && <span>@{m.github_login}</span>}
                          {!m.is_member && (
                            <span className="project-detail-member-tag">
                              GitHub only
                            </span>
                          )}
                        </span>
                      </span>
                      <span
                        className={`project-detail-member-level level-${m.level}`}
                      >
                        {m.level}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        <section className="project-detail-section">
          <h2 className="project-detail-section-title">Code repo</h2>
          <a
            className="project-detail-repo-link"
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {repoUrl}
          </a>
        </section>
      </main>
    </div>
  );
}
