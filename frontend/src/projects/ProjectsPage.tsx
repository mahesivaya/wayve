import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getVisibleProjects, type GithubRepo } from "../api/github";
import "./projects.css";

// Projects page — one block per repository (the same repos shown on the Code
// Repo page). Clicking a block opens that project's detail page (/projects/
// :owner/:repo), which shows the repo's overview and links onward to the Code
// Repo viewer. The repo list is server-filtered per user (see
// getVisibleProjects): admins/staff see all; a restricted member sees only the
// repos an admin granted them on the member page.
export default function ProjectsPage() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getVisibleProjects()
      .then((data) => {
        if (cancelled) return;
        setRepos(Array.isArray(data?.repos) ? data.repos : []);
      })
      .catch(() => !cancelled && setRepos([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const open = (r: GithubRepo) =>
    navigate(
      `/projects/${encodeURIComponent(r.owner.login)}/${encodeURIComponent(r.name)}`,
      // Pass the repo along so the detail page renders instantly without
      // re-fetching the visible-projects list.
      { state: { repo: r } }
    );

  return (
    <div className="projects-page u-page-shell">
      <header className="projects-header">
        <h1 className="projects-title">Projects</h1>
        <p className="projects-subtitle">
          Your repositories — open one to browse its code, commits and Actions.
        </p>
      </header>

      {repos === null ? (
        <p className="projects-empty">Loading…</p>
      ) : repos.length === 0 ? (
        <p className="projects-empty">No repositories yet.</p>
      ) : (
        <div className="projects-grid">
          {repos.map((r) => (
            <article
              key={r.full_name}
              className="project-card"
              role="button"
              tabIndex={0}
              aria-label={`Open ${r.full_name}`}
              onClick={() => open(r)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void open(r);
                }
              }}
            >
              <div className="project-card-head">
                <h3 className="project-card-title">{r.name}</h3>
                <span
                  className={`project-card-badge ${r.private ? "is-private" : "is-public"}`}
                >
                  {r.private ? "Private" : "Public"}
                </span>
              </div>
              {r.description && (
                <p className="project-card-desc">{r.description}</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
