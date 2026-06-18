import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  listGithubRepos,
  getRepoLanguages,
  topLanguages,
  type GithubRepo,
} from "../api/github";
import "./projects.css";

// Projects page — one block per repository (the same repos shown on the Code
// Repo page). Clicking a block opens that repo directly in the Code Repo
// viewer (deep-linked via ?owner=&repo=).
export default function ProjectsPage() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  // Top-3 languages per repo (by bytes), keyed by full_name. Fetched lazily
  // after the repo list loads — one /languages call per repo (proxy-cached).
  const [langs, setLangs] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let cancelled = false;
    listGithubRepos()
      .then((rows) => !cancelled && setRepos(Array.isArray(rows) ? rows : []))
      .catch(() => !cancelled && setRepos([]));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!repos || repos.length === 0) return;
    let cancelled = false;
    repos.forEach((r) => {
      getRepoLanguages(r.owner.login, r.name)
        .then((map) => {
          const top = topLanguages(map, 3);
          if (!cancelled && top.length > 0) {
            setLangs((prev) => ({ ...prev, [r.full_name]: top }));
          }
        })
        .catch(() => {
          /* leave this repo without a language line */
        });
    });
    return () => {
      cancelled = true;
    };
  }, [repos]);

  const open = (r: GithubRepo) =>
    navigate(
      `/github?owner=${encodeURIComponent(r.owner.login)}&repo=${encodeURIComponent(r.name)}`
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
              {(() => {
                const top =
                  langs[r.full_name] ?? (r.language ? [r.language] : []);
                if (top.length === 0) return null;
                return (
                  <div className="project-card-langs">
                    {top.map((lang) => (
                      <span key={lang} className="project-card-lang">
                        {lang}
                      </span>
                    ))}
                  </div>
                );
              })()}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
