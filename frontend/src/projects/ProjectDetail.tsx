import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  getRecentCommits,
  getRepoLanguages,
  getVisibleProjects,
  topLanguages,
  type GithubCommit,
  type GithubRepo,
} from "../api/github";
import "./projects.css";

// Relative "time ago" for the Updated / commit rows (e.g. "3 days ago"),
// falling back to "" for missing/unparseable timestamps.
const timeAgo = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.34524, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let value = -secs;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  for (const [size, u] of units) {
    unit = u;
    if (Math.abs(value) < size) break;
    value = Math.round(value / size);
  }
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    value,
    unit
  );
};

const absoluteDate = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

// Project detail page. A "project" in wayve is a linked GitHub repository, so
// this shows the repo's real metadata (visibility, owner, branch, languages,
// last activity) in a two-column overview — replacing the old behavior of
// jumping straight into the Code Repo viewer. The repo is passed via router
// state from the Projects grid for an instant render, and re-resolved from
// /projects/visible on a cold/direct load. Richer project-management fields
// (status, priority, milestones, …) are a planned follow-up.
export default function ProjectDetail() {
  const navigate = useNavigate();
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
  const [langs, setLangs] = useState<string[]>([]);
  const [commits, setCommits] = useState<GithubCommit[] | null>(null);

  // Resolve the repo when we didn't get it via navigation state (direct URL
  // load / refresh). Fall back to a synthesized stub so the page still renders
  // its name + "Open Code Repo" action even if the list can't be fetched.
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
    getRepoLanguages(owner, repoName)
      .then((data) => !cancelled && setLangs(topLanguages(data, 4)))
      .catch(() => undefined);
    getRecentCommits(owner, repoName, 5)
      .then((list) => !cancelled && setCommits(Array.isArray(list) ? list : []))
      .catch(() => !cancelled && setCommits([]));
    return () => {
      cancelled = true;
    };
  }, [owner, repoName]);

  const openCodeRepo = () =>
    navigate(
      `/github?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(
        repoName
      )}`
    );

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
        <p className="projects-empty">
          That project couldn&apos;t be found.
        </p>
      </div>
    );
  }

  const firstLang = langs[0] ?? repo.language ?? null;

  return (
    <div className="projects-page u-page-shell project-detail-page">
      <header className="project-detail-topbar">
        <nav className="project-detail-crumbs" aria-label="Breadcrumb">
          <button
            type="button"
            className="project-detail-crumb-link"
            onClick={() => navigate("/projects")}
          >
            Projects
          </button>
          <span className="project-detail-crumb-sep">›</span>
          <span className="project-detail-crumb-current">{repo.name}</span>
        </nav>
        <button
          type="button"
          className="project-detail-open"
          onClick={openCodeRepo}
        >
          Open Code Repo
        </button>
      </header>

      <div className="project-detail-grid">
        {/* Main column */}
        <main className="project-detail-main">
          <div className="project-detail-heading">
            <span className="project-detail-icon" aria-hidden="true">
              ▣
            </span>
            <h1 className="project-detail-name">{repo.name}</h1>
          </div>
          <p
            className={`project-detail-summary${
              repo.description ? "" : " is-empty"
            }`}
          >
            {repo.description || "No summary yet."}
          </p>

          <section className="project-detail-section">
            <h2 className="project-detail-section-title">Recent activity</h2>
            {commits === null ? (
              <p className="project-detail-muted">Loading activity…</p>
            ) : commits.length === 0 ? (
              <p className="project-detail-muted">No recent commits.</p>
            ) : (
              <ul className="project-detail-activity">
                {commits.map((c) => {
                  const msg = c.commit.message.split("\n")[0];
                  const who =
                    c.author?.login || c.commit.author?.name || "unknown";
                  return (
                    <li key={c.sha} className="project-detail-activity-item">
                      <a
                        className="project-detail-activity-msg"
                        href={c.html_url}
                        target="_blank"
                        rel="noreferrer"
                        title={msg}
                      >
                        {msg}
                      </a>
                      <span className="project-detail-activity-meta">
                        {who}
                        {c.commit.author?.date
                          ? ` · ${timeAgo(c.commit.author.date)}`
                          : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </main>

        {/* Properties column */}
        <aside className="project-detail-props">
          <h2 className="project-detail-props-title">Properties</h2>
          <dl className="project-detail-props-list">
            <div className="project-detail-prop">
              <dt>Visibility</dt>
              <dd>
                <span
                  className={`project-card-badge ${
                    repo.private ? "is-private" : "is-public"
                  }`}
                >
                  {repo.private ? "Private" : "Public"}
                </span>
              </dd>
            </div>
            <div className="project-detail-prop">
              <dt>Owner</dt>
              <dd>{repo.owner.login}</dd>
            </div>
            <div className="project-detail-prop">
              <dt>Default branch</dt>
              <dd>{repo.default_branch || "—"}</dd>
            </div>
            <div className="project-detail-prop">
              <dt>Language</dt>
              <dd>
                {langs.length > 0 ? (
                  <span className="project-card-langs">
                    {langs.map((l) => (
                      <span key={l} className="project-card-lang">
                        {l}
                      </span>
                    ))}
                  </span>
                ) : (
                  firstLang || "—"
                )}
              </dd>
            </div>
            <div className="project-detail-prop">
              <dt>Updated</dt>
              <dd title={absoluteDate(repo.updated_at)}>
                {timeAgo(repo.updated_at) || "—"}
              </dd>
            </div>
          </dl>
          <p className="project-detail-props-note">
            Status, priority, lead, milestones &amp; more are coming soon.
          </p>
        </aside>
      </div>
    </div>
  );
}
