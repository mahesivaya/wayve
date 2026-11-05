import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  getGithubConnection,
  getGithubConnectUrl,
  getVisibleProjects,
  listImportableRepos,
  type GithubConnection,
  type GithubRepo,
} from "../api/github";
import { deleteProject, listProjects, type Project } from "../api/workspace";
import { useAuth } from "../auth/useAuth";
import { RepoImportList, RepoUrlForm } from "../github/AddRepoForms";
import { linkedRepoNames } from "../github/repoImport";
import CodeSettingsCard from "../profile/CodeSettingsCard";
import SettingsShell from "../profile/SettingsShell";
import { canManageRepoAccess } from "./repoAccessGate";
import "./repositorySettings.css";

const messageOf = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

const fullNameOf = (p: Project) =>
  p.github_owner && p.github_repo ? `${p.github_owner}/${p.github_repo}` : null;

function RepoSettingsLink({ fullName }: { fullName: string }) {
  const [owner, name] = fullName.split("/");
  return (
    <Link
      className="settings-secondary-btn repo-settings-open"
      aria-label={`Settings for ${fullName}`}
      to={`/settings/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`}
    >
      Settings
    </Link>
  );
}

// Personal accounts and organizations: repositories are linked projects.
function ProjectRepositories({
  canManage,
  canManageAccess,
  isPersonal,
}: {
  canManage: boolean;
  canManageAccess: boolean;
  isPersonal: boolean;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [removing, setRemoving] = useState<number | null>(null);

  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch((err) => {
        setProjects([]);
        setLoadError(messageOf(err, "Couldn't load repositories."));
      });
  }, []);

  const rows = (projects ?? []).filter((p) => fullNameOf(p) !== null);
  const linked = linkedRepoNames(rows);
  const addCreated = (created: Project[]) =>
    setProjects((prev) => [...created, ...(prev ?? [])]);

  const remove = async (project: Project) => {
    if (
      !window.confirm(
        `Remove ${fullNameOf(project)}? This deletes the "${project.name}" project for everyone here. Its tasks stay but lose their project. Nothing changes on GitHub.`
      )
    ) {
      return;
    }
    setRemoving(project.id);
    setRemoveError("");
    try {
      await deleteProject(project.id);
      setProjects((prev) => (prev ?? []).filter((p) => p.id !== project.id));
    } catch (err) {
      setRemoveError(messageOf(err, "Failed to remove repository"));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <>
      {canManage && (
        <>
          <section className="settings-card repo-settings-card">
            <h2 className="settings-card-title">Add or clone by URL</h2>
            <RepoUrlForm
              linked={linked}
              canPrivate={isPersonal}
              onAdded={(project) => addCreated([project])}
            />
          </section>
          <section className="settings-card repo-settings-card">
            <h2 className="settings-card-title">Import from GitHub</h2>
            <RepoImportList
              projects={projects ?? []}
              linked={linked}
              isPersonal={isPersonal}
              onAdded={addCreated}
            />
          </section>
        </>
      )}

      <section className="settings-card repo-settings-card">
        <h2 className="settings-card-title">Your repositories</h2>
        {!canManage && (
          <p className="repo-settings-hint">
            Only your organization&apos;s owner, in admin mode, can add or
            remove repositories.
          </p>
        )}
        {projects === null ? (
          <p className="repo-settings-hint">Loading repositories…</p>
        ) : rows.length === 0 ? (
          !loadError && (
            <p className="repo-settings-hint">No repositories added yet.</p>
          )
        ) : (
          <ul className="repo-settings-list">
            {rows.map((project) => (
              <li key={project.id} className="repo-settings-row">
                <span className="repo-settings-name">
                  {fullNameOf(project)}
                </span>
                <span className="repo-settings-actions">
                  <Link
                    className="settings-secondary-btn repo-settings-open"
                    to={`/github/${project.id}`}
                  >
                    Open in Code Repo
                  </Link>
                  {canManageAccess && (
                    <RepoSettingsLink fullName={fullNameOf(project)!} />
                  )}
                  {canManage && (
                    <button
                      type="button"
                      className="settings-secondary-btn repo-settings-remove"
                      aria-label={`Remove ${fullNameOf(project)}`}
                      disabled={removing !== null}
                      onClick={() => void remove(project)}
                    >
                      {removing === project.id ? "Removing…" : "Remove"}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {(loadError || removeError) && (
          <p className="repo-settings-error" role="alert">
            {loadError || removeError}
          </p>
        )}
      </section>
    </>
  );
}

// Platform staff don't have projects to add to: Code Repo lists what the server's
// GitHub token can see, and an owner can connect GitHub to add their own.
function PlatformRepositories({
  canConnect,
  canManageAccess,
}: {
  canConnect: boolean;
  canManageAccess: boolean;
}) {
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [conn, setConn] = useState<GithubConnection | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const rows = canConnect
      ? listImportableRepos().then((res) => res.repos)
      : getVisibleProjects().then((res) => res.repos);
    void rows.then(setRepos).catch((err) => {
      setRepos([]);
      setError(messageOf(err, "Couldn't reach GitHub."));
    });
    if (canConnect) {
      void getGithubConnection()
        .then(setConn)
        .catch(() => setConn({ connected: false }));
    }
  }, [canConnect]);

  const connect = async () => {
    setError("");
    try {
      window.location.href = await getGithubConnectUrl();
    } catch (err) {
      setError(messageOf(err, "Couldn't start the GitHub connect flow."));
    }
  };

  return (
    <section className="settings-card repo-settings-card">
      <div className="repo-settings-head">
        <h2 className="settings-card-title">Platform repositories</h2>
        {conn?.connected && (
          <span className="repo-settings-muted">
            Connected as @{conn.login}
          </span>
        )}
      </div>
      <p className="repo-settings-hint">
        These come from the server&apos;s GitHub token
        {canConnect && " and your connected GitHub account"}.
      </p>
      {conn && !conn.connected && (
        <button
          type="button"
          className="repo-settings-primary"
          onClick={() => void connect()}
        >
          Connect GitHub to add your repositories
        </button>
      )}
      {repos === null ? (
        <p className="repo-settings-hint">Loading repositories…</p>
      ) : repos.length === 0 ? (
        !error && <p className="repo-settings-hint">No repositories found.</p>
      ) : (
        <ul className="repo-settings-list repo-settings-scroll">
          {repos.map((repo) => {
            const [owner, name] = repo.full_name.split("/");
            return (
              <li key={repo.full_name} className="repo-settings-row">
                <span className="repo-settings-name">
                  {repo.full_name}
                  {repo.private && (
                    <span className="repo-settings-private">Private</span>
                  )}
                </span>
                <span className="repo-settings-actions">
                  <Link
                    className="settings-secondary-btn repo-settings-open"
                    to={`/github?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(name)}`}
                  >
                    Open in Code Repo
                  </Link>
                  {canManageAccess && (
                    <RepoSettingsLink fullName={repo.full_name} />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="repo-settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// Add, import and remove the repositories shown in Code Repo. UI gating only: the
// server enforces who may add what.
export default function RepositorySettings() {
  const { user } = useAuth();
  const isPlatform = user?.scope === "platform";
  const isPersonal = user?.account_type === "personal";
  const isOwner = user?.effective_role === "owner";
  const canManageAccess = canManageRepoAccess(user);

  return (
    <SettingsShell title="Repositories">
      {user?.effective_role === "guest" ? (
        <section className="settings-card repo-settings-card">
          <p className="repo-settings-hint">
            Guests don&apos;t have access to repositories.
          </p>
        </section>
      ) : (
        <>
          {isPlatform ? (
            <PlatformRepositories
              canConnect={isOwner}
              canManageAccess={canManageAccess}
            />
          ) : (
            <ProjectRepositories
              canManage={isPersonal || isOwner}
              canManageAccess={canManageAccess}
              isPersonal={isPersonal}
            />
          )}
          <CodeSettingsCard />
        </>
      )}
    </SettingsShell>
  );
}
