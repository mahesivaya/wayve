import { useCallback, useEffect, useState } from "react";
import "./githubRepo.css";

const OWNER = "mahesivaya";
const REPO = "wayve";
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

type Repo = {
  full_name: string;
  description: string | null;
  default_branch: string;
  html_url: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  updated_at: string;
  visibility: string;
};

type Branch = {
  name: string;
  commit: { sha: string };
};

type ContentItem = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size: number;
  download_url: string | null;
};

type DirectoryCache = Record<string, ContentItem[]>;

type WorkflowRun = {
  id: number;
  name: string | null;
  display_title: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  html_url: string;
  created_at: string;
  updated_at: string;
};

type CommitItem = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: {
      name: string;
      date: string;
    } | null;
  };
  author: {
    login: string;
    avatar_url: string;
    html_url: string;
  } | null;
};

type RunsResponse = {
  workflow_runs: WorkflowRun[];
};

// Individual step inside a job — what GitHub renders as the bullet list
// under each job header on the run page. The `number` field is the
// 1-indexed position within the job (Setup is usually #1).
type JobStep = {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  started_at: string | null;
  completed_at: string | null;
};

type Job = {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps: JobStep[];
  html_url: string;
  runner_name: string | null;
  labels: string[];
};

type JobsResponse = {
  jobs: Job[];
  total_count: number;
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function firstLine(value: string) {
  return value.split("\n")[0] || "Commit";
}

/**
 * Render a duration between two ISO timestamps as a compact human label
 * (e.g. "37s", "4m 12s", "1h 22m"). Mirrors what GitHub shows in the
 * step list. Returns "—" when either endpoint is missing (step skipped
 * or not yet started) so the slot stays consistent across rows.
 */
function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "—";
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) return "—";
  const endMs = end ? Date.parse(end) : Date.now();
  if (Number.isNaN(endMs) || endMs < startMs) return "—";
  const total = Math.round((endMs - startMs) / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

/**
 * Sort directory entries the way every file browser does:
 *   1. directories first
 *   2. files second
 *   3. case-insensitive alphabetical inside each group
 *
 * The GitHub Contents API returns items in repository order (which is
 * essentially arbitrary), so without this the UI mixes folders and files
 * — the screenshot you sent had `.env.*` files interleaved with
 * `.github`, `.vscode`, `backend` directories.
 */
function sortContents(items: ContentItem[]): ContentItem[] {
  return [...items].sort((a, b) => {
    const aDir = a.type === "dir" ? 0 : 1;
    const bDir = b.type === "dir" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

// Inline SVG icons — single source render so we can theme by class and
// avoid the emoji-rendering inconsistency across OSes.
function FolderIcon() {
  return (
    <svg
      className="github-icon github-icon-folder"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M1.75 2.5h4.13l1.5 1.5h6.87a.75.75 0 0 1 .75.75v8a.75.75 0 0 1-.75.75H1.75a.75.75 0 0 1-.75-.75V3.25a.75.75 0 0 1 .75-.75Z"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      className="github-icon github-icon-file"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M3.75 1.5h6.69l3.06 3.06v9.69a.75.75 0 0 1-.75.75H3.75a.75.75 0 0 1-.75-.75V2.25a.75.75 0 0 1 .75-.75Z"
        opacity="0.18"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        d="M3.75 1.5h6.69l3.06 3.06v9.69a.75.75 0 0 1-.75.75H3.75a.75.75 0 0 1-.75-.75V2.25a.75.75 0 0 1 .75-.75Z"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        d="M10.5 1.75v3h3"
      />
    </svg>
  );
}

/**
 * Group a flat workflow_runs list by workflow name, return one node per
 * unique workflow with runs sorted newest first. The Actions panel
 * renders these as a two-level expandable tree (workflow → runs) so a
 * busy repo with many workflows stays scannable instead of showing 30
 * mixed rows.
 *
 * Rollup status (used to color the parent row): if the most-recent run
 * for the workflow has finished, use its conclusion; otherwise inherit
 * the latest run's in-progress/queued state.
 */
type WorkflowGroup = {
  name: string;
  runs: WorkflowRun[];
  rollupState: string;
};

function groupRunsByWorkflow(runs: WorkflowRun[]): WorkflowGroup[] {
  const buckets = new Map<string, WorkflowRun[]>();
  for (const run of runs) {
    const key = run.name?.trim() || "Workflow";
    const list = buckets.get(key);
    if (list) list.push(run);
    else buckets.set(key, [run]);
  }

  return Array.from(buckets.entries())
    .map(([name, list]): WorkflowGroup => {
      const sorted = [...list].sort((a, b) =>
        (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at),
      );
      const latest = sorted[0];
      const rollupState = latest?.conclusion ?? latest?.status ?? "unknown";
      return { name, runs: sorted, rollupState };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function statusLabel(run: WorkflowRun): string {
  return run.conclusion ?? run.status ?? "unknown";
}

function ChevronIcon() {
  return (
    <svg
      className="github-chevron"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6 3l5 5-5 5"
      />
    </svg>
  );
}

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

function isContentList(value: ContentItem | ContentItem[]): value is ContentItem[] {
  return Array.isArray(value);
}

export default function GitHubRepo() {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branch, setBranch] = useState("main");
  const [treeItems, setTreeItems] = useState<DirectoryCache>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<ContentItem | null>(null);
  const [fileText, setFileText] = useState("");
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [commits, setCommits] = useState<CommitItem[]>([]);
  const [workflows, setWorkflows] = useState<ContentItem[]>([]);
  // Which workflow rows in the Actions tree are expanded. Defaults to
  // empty so every workflow starts collapsed — users can expand the ones
  // they care about. State key is the workflow name (display name from
  // the workflow_run.name field).
  const [expandedWorkflows, setExpandedWorkflows] = useState<Set<string>>(new Set());
  // When the user clicks a run inside the Actions tree we fetch its
  // jobs + steps and render them INLINE beneath the run row — mirroring
  // GitHub's run detail page (jobs as cards, steps as a checklist
  // inside each job). Per-run state means multiple runs can stay
  // expanded at once and the API call is cached per run so re-toggling
  // an already-loaded run is instant.
  const [expandedRunIds, setExpandedRunIds] = useState<Set<number>>(new Set());
  const [jobsByRunId, setJobsByRunId] = useState<Record<number, Job[]>>({});
  const [loadingRunIds, setLoadingRunIds] = useState<Set<number>>(new Set());
  const [errorByRunId, setErrorByRunId] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState("");

  const loadRepo = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const [repoData, branchData, runsData] = await Promise.all([
        githubJson<Repo>(API_BASE),
        githubJson<Branch[]>(`${API_BASE}/branches?per_page=50`),
        githubJson<RunsResponse>(`${API_BASE}/actions/runs?per_page=8`),
      ]);

      setRepo(repoData);
      setBranches(branchData);
      setBranch(repoData.default_branch);
      setRuns(runsData.workflow_runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub data failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDirectory = useCallback(async (nextPath: string, nextBranch: string) => {
    setError("");
    setLoadingPaths((current) => new Set(current).add(nextPath));
    try {
      const encodedPath = nextPath
        .split("/")
        .filter(Boolean)
        .map(encodeURIComponent)
        .join("/");
      const contentPath = encodedPath ? `/${encodedPath}` : "";
      const url = `${API_BASE}/contents${contentPath}?ref=${encodeURIComponent(nextBranch)}`;
      const data = await githubJson<ContentItem | ContentItem[]>(url);
      setTreeItems((current) => ({
        ...current,
        [nextPath]: isContentList(data) ? data : [data],
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Directory failed to load");
    } finally {
      setLoadingPaths((current) => {
        const next = new Set(current);
        next.delete(nextPath);
        return next;
      });
    }
  }, []);

  const loadWorkflows = useCallback(async (nextBranch: string) => {
    try {
      const data = await githubJson<ContentItem | ContentItem[]>(
        `${API_BASE}/contents/.github/workflows?ref=${encodeURIComponent(nextBranch)}`,
      );
      setWorkflows(isContentList(data) ? data.filter((item) => item.type === "file") : []);
    } catch {
      setWorkflows([]);
    }
  }, []);

  const loadCommits = useCallback(async (nextBranch: string) => {
    try {
      const data = await githubJson<CommitItem[]>(
        `${API_BASE}/commits?sha=${encodeURIComponent(nextBranch)}&per_page=8`,
      );
      setCommits(data);
    } catch {
      setCommits([]);
    }
  }, []);

  // Toggle the run-detail flow inline. First open also fetches the
  // jobs (with steps embedded) and caches them keyed by run id so
  // re-toggling the same run doesn't re-hit GitHub's API.
  const toggleRunFlow = useCallback(async (run: WorkflowRun) => {
    let opened = false;
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(run.id)) {
        next.delete(run.id);
      } else {
        next.add(run.id);
        opened = true;
      }
      return next;
    });
    if (!opened) return;
    // If we've already fetched jobs for this run, the cached entry is
    // good enough — collapse + re-expand should feel instant.
    if (jobsByRunId[run.id]) return;

    setLoadingRunIds((current) => new Set(current).add(run.id));
    setErrorByRunId((current) => {
      const next = { ...current };
      delete next[run.id];
      return next;
    });
    try {
      const data = await githubJson<JobsResponse>(
        `${API_BASE}/actions/runs/${run.id}/jobs?per_page=100`,
      );
      setJobsByRunId((current) => ({ ...current, [run.id]: data.jobs }));
    } catch (err) {
      setErrorByRunId((current) => ({
        ...current,
        [run.id]:
          err instanceof Error ? err.message : "Could not load run details",
      }));
    } finally {
      setLoadingRunIds((current) => {
        const next = new Set(current);
        next.delete(run.id);
        return next;
      });
    }
  }, [jobsByRunId]);

  useEffect(() => {
    void loadRepo();
  }, [loadRepo]);

  useEffect(() => {
    if (!repo) return;
    setTreeItems({});
    setExpandedPaths(new Set());
    setSelectedFile(null);
    setFileText("");
    void loadDirectory("", branch);
  }, [branch, loadDirectory, repo]);

  useEffect(() => {
    if (!repo) return;
    void loadWorkflows(branch);
    void loadCommits(branch);
  }, [branch, loadCommits, loadWorkflows, repo]);

  async function openFile(item: ContentItem) {
    setSelectedFile(item);
    setFileText("");
    if (!item.download_url) return;

    setFileLoading(true);
    try {
      const response = await fetch(item.download_url);
      if (!response.ok) throw new Error(`File request failed (${response.status})`);
      const text = await response.text();
      setFileText(text.slice(0, 60000));
    } catch (err) {
      setFileText(err instanceof Error ? err.message : "File failed to load");
    } finally {
      setFileLoading(false);
    }
  }

  function toggleDirectory(item: ContentItem) {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(item.path)) {
        next.delete(item.path);
      } else {
        next.add(item.path);
        if (!treeItems[item.path]) {
          void loadDirectory(item.path, branch);
        }
      }
      return next;
    });
  }

  function renderTree(parentPath = "", depth = 0): React.ReactNode {
    const nodes = sortContents(treeItems[parentPath] ?? []);

    if (loadingPaths.has(parentPath) && nodes.length === 0) {
      return <div className="github-tree-loading">Loading...</div>;
    }

    return nodes.map((item) => {
      const isDirectory = item.type === "dir";
      const isExpanded = expandedPaths.has(item.path);
      const isLoading = loadingPaths.has(item.path);
      const isActive = selectedFile?.path === item.path;

      return (
        <div key={item.path} className="github-tree-node">
          <button
            type="button"
            className={`github-file-row ${isDirectory ? "is-dir" : "is-file"} ${isActive ? "active" : ""}`}
            style={{ "--tree-depth": depth } as React.CSSProperties}
            onClick={() => {
              if (isDirectory) {
                toggleDirectory(item);
              } else {
                void openFile(item);
              }
            }}
          >
            <span className={`github-tree-toggle ${isExpanded ? "open" : ""}`} aria-hidden="true">
              {isDirectory ? <ChevronIcon /> : null}
            </span>
            <span className="github-file-kind" aria-hidden="true">
              {isDirectory ? <FolderIcon /> : <FileIcon />}
            </span>
            <span className="github-file-name">{item.name}</span>
            <span className="github-file-size">
              {item.type === "file" ? formatSize(item.size) : ""}
            </span>
          </button>
          {isDirectory && isExpanded && (
            <div className="github-tree-children">
              {isLoading && !treeItems[item.path] ? (
                <div className="github-tree-loading">Loading...</div>
              ) : (
                renderTree(item.path, depth + 1)
              )}
            </div>
          )}
        </div>
      );
    });
  }

  if (loading) {
    return <div className="github-page github-loading">Loading GitHub repo...</div>;
  }

  return (
    <div className="github-page">
      <header className="github-header">
        <div>
          <p className="github-kicker">GitHub</p>
          <h1>{repo?.full_name ?? `${OWNER}/${REPO}`}</h1>
          <p className="github-description">{repo?.description ?? "Repository"}</p>
        </div>
        <a className="github-open" href={repo?.html_url} target="_blank" rel="noreferrer">
          Open on GitHub
        </a>
      </header>

      {error && <div className="github-banner">{error}</div>}

      <section className="github-stats" aria-label="Repository stats">
        <div>
          <span>Language</span>
          <strong>{repo?.language ?? "Mixed"}</strong>
        </div>
        <div>
          <span>Branch</span>
          <strong>{repo?.default_branch ?? "main"}</strong>
        </div>
        <div>
          <span>Stars</span>
          <strong>{repo?.stargazers_count ?? 0}</strong>
        </div>
        <div>
          <span>Forks</span>
          <strong>{repo?.forks_count ?? 0}</strong>
        </div>
        <div>
          <span>Issues</span>
          <strong>{repo?.open_issues_count ?? 0}</strong>
        </div>
        <div>
          <span>Updated</span>
          <strong>{repo ? formatDate(repo.updated_at) : "Unknown"}</strong>
        </div>
      </section>

      <div className="github-toolbar">
        <label>
          Branch
          <select
            value={branch}
            onChange={(event) => {
              setBranch(event.target.value);
            }}
          >
            {branches.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <main className="github-grid">
        <section className="github-browser" aria-label="Repository files">
          <div className="github-panel-head">
            <h2>Files</h2>
            <span>Tree</span>
          </div>
          <div className="github-file-list">
            {renderTree()}
            {!loadingPaths.has("") && (treeItems[""] ?? []).length === 0 && (
              <div className="github-empty">No files found.</div>
            )}
          </div>
        </section>

        <section className="github-preview" aria-label="File preview">
          <div className="github-panel-head">
            <h2>{selectedFile?.name ?? "Preview"}</h2>
            {selectedFile && <span>{formatSize(selectedFile.size)}</span>}
          </div>
          {fileLoading ? (
            <div className="github-empty">Loading file...</div>
          ) : selectedFile ? (
            <pre>{fileText || "No preview available."}</pre>
          ) : (
            <div className="github-empty">Select a file.</div>
          )}
        </section>
      </main>

      <section className="github-lower-grid">
        <div className="github-panel">
          <div className="github-panel-head">
            <h2>Workflows</h2>
            <span>{workflows.length}</span>
          </div>
          {workflows.map((workflow) => (
            <button
              key={workflow.path}
              type="button"
              className="github-workflow"
              onClick={() => void openFile(workflow)}
            >
              <span>{workflow.name}</span>
              <small>{formatSize(workflow.size)}</small>
            </button>
          ))}
          {workflows.length === 0 && <div className="github-empty">No workflows found.</div>}
        </div>

        <div className="github-panel">
          <div className="github-panel-head">
            <h2>Commits</h2>
            <span>{commits.length}</span>
          </div>
          {commits.map((commit) => (
            <a
              key={commit.sha}
              className="github-commit"
              href={commit.html_url}
              target="_blank"
              rel="noreferrer"
            >
              <span className="github-commit-main">
                <strong>{firstLine(commit.commit.message)}</strong>
                <small>
                  {(commit.author?.login ?? commit.commit.author?.name ?? "Unknown")} ·{" "}
                  {commit.commit.author ? formatDate(commit.commit.author.date) : "Unknown"}
                </small>
              </span>
              <code>{commit.sha.slice(0, 7)}</code>
            </a>
          ))}
          {commits.length === 0 && <div className="github-empty">No commits found.</div>}
        </div>

        <div className="github-panel">
          <div className="github-panel-head">
            <h2>Actions</h2>
            <span>{runs.length}</span>
          </div>

          {/* Tree view of workflow runs:
                Workflow ──▸ (chevron toggles)
                   ├─ ● run #N · branch · 5m ago        success
                   ├─ ● run #M · branch · 1h ago        failure
                   └─ ● run #X · branch · 1d ago        cancelled
              The rollup colored dot on the workflow row mirrors the
              latest run's state so the parent reads at-a-glance even
              when collapsed. */}
          <div className="github-actions-tree">
            {groupRunsByWorkflow(runs).map((group) => {
              const isExpanded = expandedWorkflows.has(group.name);
              return (
                <div key={group.name} className="github-actions-node">
                  <button
                    type="button"
                    className="github-actions-row is-workflow"
                    onClick={() => {
                      setExpandedWorkflows((current) => {
                        const next = new Set(current);
                        if (next.has(group.name)) next.delete(group.name);
                        else next.add(group.name);
                        return next;
                      });
                    }}
                    aria-expanded={isExpanded}
                  >
                    <span
                      className={`github-tree-toggle ${isExpanded ? "open" : ""}`}
                      aria-hidden="true"
                    >
                      <ChevronIcon />
                    </span>
                    <span
                      className={`github-status-dot status-${group.rollupState}`}
                      aria-hidden="true"
                    />
                    <span className="github-actions-name">{group.name}</span>
                    <span className="github-actions-count">
                      {group.runs.length} {group.runs.length === 1 ? "run" : "runs"}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="github-actions-children" role="list">
                      {group.runs.map((run) => {
                        const state = statusLabel(run);
                        const isOpen = expandedRunIds.has(run.id);
                        const isLoading = loadingRunIds.has(run.id);
                        const runError = errorByRunId[run.id];
                        const runJobs = jobsByRunId[run.id] ?? [];
                        return (
                          <div key={run.id} className="github-actions-run-node" role="listitem">
                            <button
                              type="button"
                              className={`github-actions-row is-run ${isOpen ? "is-open" : ""}`}
                              onClick={() => void toggleRunFlow(run)}
                              aria-expanded={isOpen}
                              aria-label={`Toggle ${run.display_title} run details`}
                            >
                              <span className="github-actions-rail" aria-hidden="true" />
                              <span
                                className={`github-status-dot status-${state}`}
                                aria-hidden="true"
                              />
                              <span className="github-actions-run-main">
                                <strong>{run.display_title}</strong>
                                <small>
                                  {run.head_branch}
                                  {" · "}
                                  {formatDate(run.updated_at ?? run.created_at)}
                                </small>
                              </span>
                              <em className={`github-actions-state ${state}`}>{state}</em>
                            </button>

                            {isOpen && (
                              <div className="github-flow github-flow-inline">
                                {isLoading && (
                                  <div className="github-flow-empty">Loading jobs…</div>
                                )}

                                {runError && (
                                  <div className="github-banner">{runError}</div>
                                )}

                                {!isLoading && !runError && runJobs.length === 0 && (
                                  <div className="github-flow-empty">
                                    This run has no jobs to display.
                                  </div>
                                )}

                                {/* Job cards: one column per job. Inside each, steps
                                    are a vertical checklist with status dots, names,
                                    and durations — same shape as GitHub's job pane.
                                    The cards wrap so multi-job matrices fall onto
                                    multiple rows instead of horizontal-scrolling. */}
                                {runJobs.length > 0 && (
                                  <div className="github-flow-jobs">
                                    {runJobs.map((job) => {
                                      const jobState = job.conclusion ?? job.status ?? "unknown";
                                      return (
                                        <article
                                          key={job.id}
                                          className={`github-flow-job state-${jobState}`}
                                        >
                                          <header className="github-flow-job-head">
                                            <span
                                              className={`github-status-dot status-${jobState}`}
                                              aria-hidden="true"
                                            />
                                            <span className="github-flow-job-title">
                                              <strong>{job.name}</strong>
                                              <small>
                                                {formatDuration(job.started_at, job.completed_at)}
                                                {job.runner_name ? ` · ${job.runner_name}` : ""}
                                              </small>
                                            </span>
                                            <a
                                              className="github-flow-job-link"
                                              href={job.html_url}
                                              target="_blank"
                                              rel="noreferrer"
                                              aria-label={`Open ${job.name} on GitHub`}
                                              title="Open on GitHub"
                                            >
                                              ↗
                                            </a>
                                          </header>

                                          <ol className="github-flow-steps">
                                            {job.steps
                                              .slice()
                                              .sort((a, b) => a.number - b.number)
                                              .map((step) => {
                                                const stepState =
                                                  step.conclusion ?? step.status ?? "unknown";
                                                return (
                                                  <li
                                                    key={`${job.id}-${step.number}`}
                                                    className="github-flow-step"
                                                  >
                                                    <span
                                                      className={`github-status-dot status-${stepState}`}
                                                      aria-hidden="true"
                                                    />
                                                    <span className="github-flow-step-name">
                                                      {step.name}
                                                    </span>
                                                    <span className="github-flow-step-dur">
                                                      {formatDuration(
                                                        step.started_at,
                                                        step.completed_at,
                                                      )}
                                                    </span>
                                                  </li>
                                                );
                                              })}
                                            {job.steps.length === 0 && (
                                              <li className="github-flow-step is-empty">
                                                No steps reported.
                                              </li>
                                            )}
                                          </ol>
                                        </article>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {runs.length === 0 && <div className="github-empty">No runs found.</div>}
          </div>
        </div>
      </section>

    </div>
  );
}
