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
import {
  createProject,
  deleteProject,
  listProjects,
  type Project,
} from "../api/workspace";
import { useAuth } from "../auth/useAuth";
import { importAllRepos, repoNameFromUrl } from "../github/repoImport";
import SettingsShell from "../profile/SettingsShell";
import "./repositorySettings.css";

const messageOf = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

const fullNameOf = (p: Project) =>
  p.github_owner && p.github_repo ? `${p.github_owner}/${p.github_repo}` : null;

// What was pasted, as owner/repo. The server has the final say on the rest.
function pastedFullName(value: string): string | null {
  const match = /([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(value);
  return match ? `${match[1]}/${match[2]}` : null;
}

function AddRepository({
  linked,
  canPrivate,
  onAdded,
}: {
  linked: Set<string>;
  canPrivate: boolean;
  onAdded: (project: Project) => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    // People paste the whole command from GitHub's Clone button.
    const value = url.replace(/^\s*git\s+clone\s+/, "").trim();
    if (!value || busy) return;
    if (linked.has(pastedFullName(value)?.toLowerCase() ?? "")) {
      setError("This repository is already added.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onAdded(await createProject(repoNameFromUrl(value), value));
      setUrl("");
    } catch (err) {
      setError(messageOf(err, "Failed to add repository"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-card repo-settings-card">
      <h2 className="settings-card-title">Add or clone by URL</h2>
      <form
        className="repo-settings-add"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          className="repo-settings-input"
          type="text"
          aria-label="Repository URL"
          placeholder="https://github.com/owner/repo.git"
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          type="submit"
          className="repo-settings-primary"
          disabled={busy || !url.trim()}
        >
          {busy ? "Adding…" : "Add repository"}
        </button>
      </form>
      <p className="repo-settings-hint">
        Paste a GitHub HTTPS or SSH clone URL.{" "}
        {canPrivate
          ? "Private repositories work once your GitHub is connected."
          : "Organization repositories must be public."}{" "}
        The code is read live from GitHub; no copy is stored here.
      </p>
      {error && (
        <p className="repo-settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ImportFromGithub({
  projects,
  linked,
  isPersonal,
  onAdded,
}: {
  projects: Project[];
  linked: Set<string>;
  isPersonal: boolean;
  onAdded: (created: Project[]) => void;
}) {
  // Null while loading.
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [login, setLogin] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [importingRepo, setImportingRepo] = useState<string | null>(null);
  const [importingAll, setImportingAll] = useState(false);
  const [importCount, setImportCount] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    void listImportableRepos()
      .then((res) => {
        setConnected(res.connected);
        setRepos(res.repos);
      })
      .catch((err) => {
        setRepos([]);
        setConnected(true);
        setError(messageOf(err, "Couldn't reach GitHub."));
      });
    if (isPersonal) {
      void getGithubConnection()
        .then((conn) => setLogin(conn.login))
        .catch(() => {});
    }
  }, [isPersonal]);

  const connect = async () => {
    setError("");
    try {
      window.location.href = await getGithubConnectUrl();
    } catch (err) {
      setError(messageOf(err, "Couldn't start the GitHub connect flow."));
    }
  };

  const importOne = async (repo: GithubRepo) => {
    setImportingRepo(repo.full_name);
    setError("");
    try {
      onAdded([
        await createProject(repo.name, `https://github.com/${repo.full_name}`),
      ]);
    } catch (err) {
      setError(messageOf(err, `Couldn't import ${repo.full_name}.`));
    } finally {
      setImportingRepo(null);
    }
  };

  const importAll = async () => {
    setImportingAll(true);
    setImportCount(0);
    setError("");
    try {
      onAdded(await importAllRepos(projects, setImportCount));
    } catch (err) {
      setError(messageOf(err, "Couldn't reach GitHub."));
    } finally {
      setImportingAll(false);
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = (repos ?? []).filter((r) =>
    r.full_name.toLowerCase().includes(needle)
  );
  const remaining = (repos ?? []).filter(
    (r) => !linked.has(r.full_name.toLowerCase())
  ).length;
  const busy = importingAll || importingRepo !== null;

  return (
    <section className="settings-card repo-settings-card">
      <div className="repo-settings-head">
        <h2 className="settings-card-title">Import from GitHub</h2>
        {login && (
          <span className="repo-settings-muted">Connected as @{login}</span>
        )}
      </div>
      {repos === null ? (
        <p className="repo-settings-hint">Loading repositories…</p>
      ) : !connected ? (
        <>
          <p className="repo-settings-hint">
            Connect your GitHub account to pick from your repositories, private
            ones included.
          </p>
          <button
            type="button"
            className="repo-settings-primary"
            onClick={() => void connect()}
          >
            Connect GitHub
          </button>
        </>
      ) : repos.length === 0 ? (
        !error && <p className="repo-settings-hint">No repositories found.</p>
      ) : (
        <>
          <div className="repo-settings-add">
            <input
              className="repo-settings-input"
              type="search"
              aria-label="Find a repository to import"
              placeholder="Find a repository…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              className="settings-secondary-btn"
              disabled={busy || remaining === 0}
              onClick={() => void importAll()}
            >
              {importingAll
                ? `Importing… (${importCount})`
                : `Import all (${remaining})`}
            </button>
          </div>
          <ul className="repo-settings-list repo-settings-scroll">
            {shown.map((repo) => {
              const added = linked.has(repo.full_name.toLowerCase());
              return (
                <li key={repo.full_name} className="repo-settings-row">
                  <span className="repo-settings-name">
                    {repo.full_name}
                    {repo.private && (
                      <span className="repo-settings-private">Private</span>
                    )}
                  </span>
                  {added ? (
                    <span className="repo-settings-muted">Added</span>
                  ) : (
                    <button
                      type="button"
                      className="settings-secondary-btn"
                      disabled={busy}
                      onClick={() => void importOne(repo)}
                    >
                      {importingRepo === repo.full_name
                        ? "Importing…"
                        : "Import"}
                    </button>
                  )}
                </li>
              );
            })}
            {shown.length === 0 && (
              <li className="repo-settings-hint">No repositories match.</li>
            )}
          </ul>
        </>
      )}
      {error && (
        <p className="repo-settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// Personal accounts and organizations: repositories are linked projects.
function ProjectRepositories({
  canManage,
  isPersonal,
}: {
  canManage: boolean;
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
  const linked = new Set(rows.map((p) => fullNameOf(p)!.toLowerCase()));
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
          <AddRepository
            linked={linked}
            canPrivate={isPersonal}
            onAdded={(project) => addCreated([project])}
          />
          <ImportFromGithub
            projects={projects ?? []}
            linked={linked}
            isPersonal={isPersonal}
            onAdded={addCreated}
          />
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
function PlatformRepositories({ canConnect }: { canConnect: boolean }) {
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
                <Link
                  className="settings-secondary-btn repo-settings-open"
                  to={`/github?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(name)}`}
                >
                  Open in Code Repo
                </Link>
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

  return (
    <SettingsShell title="Repositories">
      {user?.effective_role === "guest" ? (
        <section className="settings-card repo-settings-card">
          <p className="repo-settings-hint">
            Guests don&apos;t have access to repositories.
          </p>
        </section>
      ) : isPlatform ? (
        <PlatformRepositories canConnect={isOwner} />
      ) : (
        <ProjectRepositories
          canManage={isPersonal || isOwner}
          isPersonal={isPersonal}
        />
      )}
    </SettingsShell>
  );
}
