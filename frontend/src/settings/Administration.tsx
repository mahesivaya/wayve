import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  listProjects,
  listTeams,
  type Project,
  type Team,
} from "../api/workspace";
import { useAuth } from "../auth/useAuth";
import { isWorkspaceAdmin } from "../auth/workspaceAdmin";
import SettingsShell from "../profile/SettingsShell";
import "./repositorySettings.css";

// Settings › Administration: the organization's (or platform's) teams and
// projects, for its admins. The lists come from the same endpoints as the
// sidebar, which return everything in scope to an owner, super admin or admin.

function AdminList<T>({
  title,
  heading,
  noun,
  load,
  row,
}: {
  title: string;
  heading: string;
  noun: string;
  load: () => Promise<T[]>;
  row: (item: T) => { key: number; name: string; action: ReactNode };
}) {
  const { user } = useAuth();
  const allowed = isWorkspaceAdmin(user);
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    void load()
      .then((rows) => {
        if (!cancelled) setItems(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (cancelled) return;
        setItems([]);
        setError(`Couldn't load ${noun}.`);
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, load, noun]);

  return (
    <SettingsShell title={title}>
      <section className="settings-card repo-settings-card">
        <h2 className="settings-card-title">{heading}</h2>
        {!allowed ? (
          <p className="repo-settings-hint">
            Only owners and admins, in admin mode, can open this page.
          </p>
        ) : items === null ? (
          <p className="repo-settings-hint">Loading {noun}…</p>
        ) : error ? (
          <p className="repo-settings-error">{error}</p>
        ) : items.length === 0 ? (
          <p className="repo-settings-hint">No {noun} yet.</p>
        ) : (
          <ul className="repo-settings-list">
            {items.map((item) => {
              const { key, name, action } = row(item);
              return (
                <li key={key} className="repo-settings-row">
                  <span className="repo-settings-name">{name}</span>
                  <span className="repo-settings-actions">{action}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </SettingsShell>
  );
}

const teamRow = (team: Team) => ({
  key: team.id,
  name: team.name,
  action: (
    <Link
      className="settings-secondary-btn repo-settings-open"
      aria-label={`Open ${team.name}`}
      to={`/teams/${encodeURIComponent(team.slug)}`}
    >
      Open
    </Link>
  ),
});

// A project opens its page through its linked repository; one with no
// repository linked has no page yet.
const projectRow = (project: Project) => ({
  key: project.id,
  name: project.name,
  action:
    project.github_owner && project.github_repo ? (
      <Link
        className="settings-secondary-btn repo-settings-open"
        aria-label={`Open ${project.name}`}
        to={`/projects/${encodeURIComponent(
          project.github_owner
        )}/${encodeURIComponent(project.github_repo)}`}
      >
        Open
      </Link>
    ) : (
      <span className="repo-settings-muted">No repository linked</span>
    ),
});

export function AdminTeams() {
  return (
    <AdminList
      title="Teams"
      heading="All teams"
      noun="teams"
      load={listTeams}
      row={teamRow}
    />
  );
}

export function AdminProjects() {
  return (
    <AdminList
      title="Projects"
      heading="All projects"
      noun="projects"
      load={listProjects}
      row={projectRow}
    />
  );
}
