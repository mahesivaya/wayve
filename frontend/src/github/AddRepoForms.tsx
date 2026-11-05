import { useEffect, useState } from "react";

import {
  disconnectGithub,
  getGithubConnection,
  getGithubConnectUrl,
  listImportableRepos,
  type GithubRepo,
} from "../api/github";
import { createProject, type Project } from "../api/workspace";
import { importAllRepos, linkedRepoNames, repoNameFromUrl } from "./repoImport";
import "../settings/repositorySettings.css";

// The two ways to add a repository, shared by Settings > Repositories and the
// Code Repo page. Both create a linked project; the server decides who may.

const messageOf = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

// What was pasted, as owner/repo. The server has the final say on the rest.
function pastedFullName(value: string): string | null {
  const match = /([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(value);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function RepoUrlForm({
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
    <>
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
    </>
  );
}

export function RepoImportList({
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

  const disconnect = async () => {
    setError("");
    try {
      await disconnectGithub();
      setConnected(false);
      setRepos([]);
      setLogin(undefined);
    } catch (err) {
      setError(messageOf(err, "Couldn't disconnect GitHub."));
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
      const created = await importAllRepos(projects, setImportCount);
      if (created.length === 0) {
        setError("None of these repositories could be imported.");
      } else {
        onAdded(created);
      }
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
    <>
      {login && connected && (
        <p className="repo-settings-hint">
          Connected as @{login}
          {" · "}
          <button
            type="button"
            className="repo-settings-link"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            Disconnect
          </button>
        </p>
      )}
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
              className="repo-settings-secondary"
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
                      className="repo-settings-secondary"
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
    </>
  );
}

export type AddRepoTab = "clone" | "import";

const TABS: { id: AddRepoTab; label: string }[] = [
  { id: "clone", label: "Clone URL" },
  { id: "import", label: "Import from GitHub" },
];

// Clone or import, one at a time: Code Repo has less room than Settings, which
// shows the two as separate cards.
export function AddRepoTabs({
  projects,
  isPersonal,
  initialTab = "clone",
  onAdded,
}: {
  projects: Project[];
  isPersonal: boolean;
  initialTab?: AddRepoTab;
  onAdded: (created: Project[]) => void;
}) {
  const [tab, setTab] = useState<AddRepoTab>(initialTab);
  const linked = linkedRepoNames(projects);

  return (
    <div className="repo-add-tabs">
      <div className="repo-add-tablist" role="tablist" aria-label="Add from">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`repo-add-tab${tab === id ? " is-active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
        {tab === "clone" ? (
          <RepoUrlForm
            linked={linked}
            canPrivate={isPersonal}
            onAdded={(project) => onAdded([project])}
          />
        ) : (
          <RepoImportList
            projects={projects}
            linked={linked}
            isPersonal={isPersonal}
            onAdded={onAdded}
          />
        )}
      </div>
    </div>
  );
}
