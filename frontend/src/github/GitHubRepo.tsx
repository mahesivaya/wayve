import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { fmtDateTime } from "../utils/datetime";
import { useResizableWidth } from "../components/useResizableWidth";
import { useAuth } from "../auth/useAuth";
import { getAuthToken } from "../auth/token";
import {
  listProjects,
  createProject,
  linkProjectRepo,
  type Project,
} from "../api/workspace";
import "./githubRepo.css";

// The platform team's legacy single-repo dashboard (the bare /github route
// with no project). Personal accounts get their own repos via /github/:id.
const FALLBACK_OWNER = "mahesivaya";
const FALLBACK_REPO = "wayve";
// All GitHub calls go through our own backend proxy at /api/github/*.
// The proxy:
//   * gates on a logged-in Wayve session (no anon access) and authorizes the
//     repo per caller (platform = full; personal = own linked repos only),
//   * attaches the server-held GITHUB_TOKEN PAT, lifting the rate
//     limit from 60/hr to 5000/hr without ever exposing the token to
//     the browser,
//   * caches GET responses for 60s, so the N-calls-per-mount we do
//     here don't compound across reloads.
// The path shape (`/repos/{owner}/{repo}/...`) matches GitHub's API
// 1:1, so request URLs from this file read the same as before. The
// `owner`/`repo` are now per-viewer props (see GitHubRepoViewer).

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

/**
 * Detail view of a single commit fetched from
 * `/repos/{owner}/{repo}/commits/{sha}`. The diff payload lives under
 * `files[].patch` — a unified-diff string that we render line-by-line
 * with +/- coloring. `stats` rolls up additions/deletions across files
 * so the commit row can show "+12 −4" without summing patches client-
 * side.
 */
type CommitFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string | null;
  previous_filename?: string | null;
};

type CommitDetail = {
  sha: string;
  files?: CommitFile[];
  stats?: {
    total: number;
    additions: number;
    deletions: number;
  };
  parents?: Array<{ sha: string; html_url: string }>;
};

type RunsResponse = {
  workflow_runs: WorkflowRun[];
  total_count: number;
};

// How many runs we pull per `/actions/runs` page. 50 matches GitHub's
// own "453 workflow runs" view density without blowing past the
// API's 100/page max. The "Load more" affordance pages further if the
// repo has more than this.
const RUNS_PER_PAGE = 50;

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
  return Number.isNaN(date.getTime()) ? "Unknown" : fmtDateTime(date);
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
        (b.updated_at ?? b.created_at).localeCompare(
          a.updated_at ?? a.created_at
        )
      );
      const latest = sorted[0];
      const rollupState = latest?.conclusion ?? latest?.status ?? "unknown";
      return { name, runs: sorted, rollupState };
    })
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
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

/**
 * GitHub-style round status icon for a job or step. Inlined SVG so colors
 * theme through CSS `currentColor` via the `.status-<state>` class.
 *
 *   success         — filled circle + white check
 *   failure/timed_out/startup_failure — filled red circle + white x
 *   cancelled       — outlined circle + diagonal stroke (corner-to-corner)
 *   skipped/neutral — outlined circle + opposite diagonal slash
 *   in_progress     — dashed outlined circle (CSS spin)
 *   queued/pending  — plain outlined circle
 */
function StatusIcon({ state }: { state: string }) {
  const cls = `github-status-icon status-${state}`;
  switch (state) {
    case "success":
      return (
        <svg
          className={cls}
          viewBox="0 0 16 16"
          width="16"
          height="16"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="7.25" fill="currentColor" />
          <path
            fill="none"
            stroke="#fff"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4.5 8.5l2.4 2.4 4.7-4.8"
          />
        </svg>
      );
    case "failure":
    case "timed_out":
    case "startup_failure":
      return (
        <svg
          className={cls}
          viewBox="0 0 16 16"
          width="16"
          height="16"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="7.25" fill="currentColor" />
          <path
            fill="none"
            stroke="#fff"
            strokeWidth="1.8"
            strokeLinecap="round"
            d="M5.5 5.5l5 5M10.5 5.5l-5 5"
          />
        </svg>
      );
    case "cancelled":
      return (
        <svg
          className={cls}
          viewBox="0 0 16 16"
          width="16"
          height="16"
          aria-hidden="true"
        >
          <circle
            cx="8"
            cy="8"
            r="6.75"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <line
            x1="4.5"
            y1="4.5"
            x2="11.5"
            y2="11.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      );
    case "skipped":
    case "neutral":
      return (
        <svg
          className={cls}
          viewBox="0 0 16 16"
          width="16"
          height="16"
          aria-hidden="true"
        >
          <circle
            cx="8"
            cy="8"
            r="6.75"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <line
            x1="4.5"
            y1="11.5"
            x2="11.5"
            y2="4.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      );
    case "in_progress":
    case "waiting":
    case "requested":
      return (
        <svg
          className={`${cls} is-spinning`}
          viewBox="0 0 16 16"
          width="16"
          height="16"
          aria-hidden="true"
        >
          <circle
            cx="8"
            cy="8"
            r="6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeDasharray="6 4"
            strokeLinecap="round"
          />
        </svg>
      );
    case "queued":
    case "pending":
    default:
      return (
        <svg
          className={cls}
          viewBox="0 0 16 16"
          width="16"
          height="16"
          aria-hidden="true"
        >
          <circle
            cx="8"
            cy="8"
            r="6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      );
  }
}

async function githubJson<T>(url: string): Promise<T> {
  // Authenticate the same way as the rest of the app: a Bearer token from
  // localStorage (the cookie alone is unreliable in token-only sessions).
  // The proxy attaches the Accept + X-GitHub-Api-Version headers server-side.
  const token = getAuthToken();
  const response = await fetch(url, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    // A 403 from the proxy means this account isn't allowed to read this repo
    // (not linked to one of your projects) — surface a plain message.
    if (response.status === 403) {
      throw new Error("You don't have access to this repository.");
    }
    throw new Error(`GitHub request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

function isContentList(
  value: ContentItem | ContentItem[]
): value is ContentItem[] {
  return Array.isArray(value);
}

function GitHubRepoViewer({
  owner,
  repo: repoName,
  repoSwitcher,
}: {
  owner: string;
  repo: string;
  // Optional repo selector rendered at the top of the left rail, above the
  // Branch block (used by the personal in-page manager).
  repoSwitcher?: ReactNode;
}) {
  // Per-viewer proxy base. Stable for the component's lifetime because the
  // outer wrapper keys this viewer by `${owner}/${repo}` (it remounts when the
  // linked repo changes), so callbacks can capture it safely.
  const API_BASE = `/api/github/repos/${owner}/${repoName}`;
  const [repo, setRepo] = useState<Repo | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branch, setBranch] = useState("main");
  // Custom branch dropdown (replaces a native <select> so the list reliably
  // opens downward and the branch names can be themed).
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const branchMenuRef = useRef<HTMLDivElement | null>(null);

  // Close the branch menu on outside click or Escape.
  useEffect(() => {
    if (!branchMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        branchMenuRef.current &&
        !branchMenuRef.current.contains(e.target as Node)
      ) {
        setBranchMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBranchMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [branchMenuOpen]);
  const [treeItems, setTreeItems] = useState<DirectoryCache>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<ContentItem | null>(null);
  const [fileText, setFileText] = useState("");
  // README contents for the Description tab. Fetched per branch (like
  // workflows/commits) and rendered as raw text — there's no markdown
  // renderer wired up, and markdown stays human-readable as-is.
  const [readme, setReadme] = useState("");
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [commits, setCommits] = useState<CommitItem[]>([]);
  // Per-commit detail (file diffs) loaded on demand when a commit row
  // is expanded. Cached by SHA so toggling open → closed → open doesn't
  // re-hit GitHub. Aux maps track which commits are expanded, currently
  // loading, or have an error to surface inline.
  const [expandedCommitShas, setExpandedCommitShas] = useState<Set<string>>(
    new Set()
  );
  const [commitDetailBySha, setCommitDetailBySha] = useState<
    Record<string, CommitDetail>
  >({});
  const [loadingCommitShas, setLoadingCommitShas] = useState<Set<string>>(
    new Set()
  );
  const [errorByCommitSha, setErrorByCommitSha] = useState<
    Record<string, string>
  >({});
  // Raw unified-diff text fetched on demand via the proxy's
  // `?media=diff` opt-in. This is the fallback for commits where the
  // JSON `files[].patch` is missing (GitHub truncates patches over
  // ~300 KB or for binary-adjacent files). Keyed by SHA so re-opening
  // the same commit's full diff is instant.
  const [fullDiffBySha, setFullDiffBySha] = useState<Record<string, string>>(
    {}
  );
  const [loadingFullDiffShas, setLoadingFullDiffShas] = useState<Set<string>>(
    new Set()
  );
  const [errorFullDiffBySha, setErrorFullDiffBySha] = useState<
    Record<string, string>
  >({});
  const [workflows, setWorkflows] = useState<ContentItem[]>([]);
  // Which workflow rows in the Actions tree are expanded. Defaults to
  // empty so every workflow starts collapsed — users can expand the ones
  // they care about. State key is the workflow name (display name from
  // the workflow_run.name field).
  const [expandedWorkflows, setExpandedWorkflows] = useState<Set<string>>(
    new Set()
  );
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
  // Second-level expansion inside the run-detail flow. Clicking a job
  // header reveals/hides its step checklist — GitHub-style. State is
  // keyed by job id (globally unique) so multiple jobs across multiple
  // runs can stay open independently.
  const [expandedJobIds, setExpandedJobIds] = useState<Set<number>>(new Set());
  // Paginated history of workflow runs. `runsPage` is the most-recent
  // page we've fetched; `runsTotal` comes from GitHub's total_count
  // header so we know when to hide the "Load more" affordance.
  const [runsPage, setRunsPage] = useState(1);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsLoadingMore, setRunsLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState("");

  // Section nav for the left rail. Persist the user's last view so
  // re-opening /github lands them on the same panel.
  type Section = "description" | "files" | "workflows" | "commits" | "actions";
  const [activeSection, setActiveSection] = useState<Section>(() => {
    try {
      const raw = localStorage.getItem("rwayve.github.section");
      if (
        raw === "files" ||
        raw === "workflows" ||
        raw === "commits" ||
        raw === "actions"
      ) {
        return raw;
      }
    } catch {
      // ignore
    }
    // Default landing tab: the project overview, so users grasp what the
    // project is before diving into code. A previously-selected tab is
    // remembered above (persisted in the effect below).
    return "description";
  });

  useEffect(() => {
    try {
      localStorage.setItem("rwayve.github.section", activeSection);
    } catch {
      // ignore
    }
  }, [activeSection]);

  // Resizable split between the file tree and the preview panel. Default
  // 280px gives the tree room for typical file names while leaving the
  // preview as the larger pane. Persisted; shared useResizableWidth hook.
  const { width: filesPaneWidth, startResize: handleFilesPaneResize } =
    useResizableWidth({
      storageKey: "rwayve.github.filesPaneWidth",
      defaultWidth: 280,
      min: 180,
      max: 720,
    });

  const loadRepo = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      // Fetch the repo first; only this is fatal. Branches are best-effort —
      // an empty repo (no commits) legitimately has none, so a failure there
      // shouldn't blank the whole view.
      const repoData = await githubJson<Repo>(API_BASE);
      setRepo(repoData);
      setBranch(repoData.default_branch);
      const branchData = await githubJson<Branch[]>(
        `${API_BASE}/branches?per_page=50`
      ).catch(() => [] as Branch[]);
      setBranches(branchData);
      // Runs are fetched by the branch-driven effect below (so the list
      // re-filters when the user switches branches).
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "GitHub data failed to load";
      // The shared token can list a repo via /user/repos but still get a 404
      // opening it directly (private/org repo it can't read, empty repo, or
      // one renamed since the list was fetched). Surface that plainly.
      setError(
        msg.includes("404")
          ? "This repository couldn't be opened — it may be empty, private, or not accessible with the current GitHub access."
          : msg
      );
    } finally {
      setLoading(false);
    }
  }, [API_BASE]);

  /**
   * Fetch a page of workflow runs. We deliberately do NOT pass
   * `branch=` — a push to ANY branch should surface under Actions so
   * the user can see CI activity without having to switch the branch
   * picker first. The Actions panel header makes this explicit with a
   * "Showing runs from all workflows" subtitle.
   *
   * `append` means we're paging through history (preserves runs
   * already loaded); otherwise the result REPLACES the list.
   */
  const loadRuns = useCallback(
    async (page: number, append: boolean) => {
      if (append) setRunsLoadingMore(true);
      // Clear any stale banner from a previous attempt so a successful
      // retry doesn't leave the error visible. The other loaders
      // (loadRepo, loadDirectory) already do this; loadRuns was the
      // outlier and caused the 404 banner to stick across page state.
      setError("");
      try {
        const url =
          `${API_BASE}/actions/runs` +
          `?per_page=${RUNS_PER_PAGE}` +
          `&page=${page}`;
        const data = await githubJson<RunsResponse>(url);
        setRunsTotal(data.total_count ?? 0);
        setRunsPage(page);
        setRuns((current) =>
          append ? [...current, ...data.workflow_runs] : data.workflow_runs
        );
        if (!append) {
          // Default every workflow group to expanded so the Actions
          // panel reads as a flat run list out-of-the-box — matches
          // GitHub's own /actions view. The user can still collapse a
          // workflow they want to hide; that state survives "Load more"
          // because we only seed the set on replace, not on append.
          const names = new Set(
            data.workflow_runs.map((run) => run.name?.trim() || "Workflow")
          );
          setExpandedWorkflows(names);
        }
      } catch (err) {
        // Surface the error but don't blow up the rest of the page —
        // the user still has files / commits / workflows on screen.
        setError(
          err instanceof Error ? err.message : "Action runs failed to load"
        );
        if (!append) {
          setRuns([]);
          setRunsTotal(0);
        }
      } finally {
        setRunsLoadingMore(false);
      }
    },
    [API_BASE]
  );

  const loadDirectory = useCallback(
    async (nextPath: string, nextBranch: string) => {
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
        setError(
          err instanceof Error ? err.message : "Directory failed to load"
        );
      } finally {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(nextPath);
          return next;
        });
      }
    },
    [API_BASE]
  );

  const loadWorkflows = useCallback(
    async (nextBranch: string) => {
      try {
        const data = await githubJson<ContentItem | ContentItem[]>(
          `${API_BASE}/contents/.github/workflows?ref=${encodeURIComponent(nextBranch)}`
        );
        setWorkflows(
          isContentList(data) ? data.filter((item) => item.type === "file") : []
        );
      } catch {
        setWorkflows([]);
      }
    },
    [API_BASE]
  );

  // README for the Description tab. Resolve the file metadata via the
  // proxied Contents API, then fetch its raw text from download_url (same
  // two-step the file preview uses in openFile). Any failure — most
  // commonly a repo with no README — clears the text so the pane shows
  // its graceful fallback rather than an error.
  const loadReadme = useCallback(
    async (nextBranch: string) => {
      setReadmeLoading(true);
      try {
        const data = await githubJson<ContentItem | ContentItem[]>(
          `${API_BASE}/contents/README.md?ref=${encodeURIComponent(nextBranch)}`
        );
        const item = isContentList(data) ? data[0] : data;
        if (!item?.download_url) {
          setReadme("");
          return;
        }
        const response = await fetch(item.download_url);
        if (!response.ok)
          throw new Error(`README request failed (${response.status})`);
        const text = await response.text();
        setReadme(text.slice(0, 60000));
      } catch {
        setReadme("");
      } finally {
        setReadmeLoading(false);
      }
    },
    [API_BASE]
  );

  const loadCommits = useCallback(
    async (nextBranch: string) => {
      try {
        const data = await githubJson<CommitItem[]>(
          `${API_BASE}/commits?sha=${encodeURIComponent(nextBranch)}&per_page=8`
        );
        setCommits(data);
      } catch {
        setCommits([]);
      }
    },
    [API_BASE]
  );

  // Expand a commit row inline to show its file-level diff. First open
  // fetches the per-commit detail (which includes the patch for every
  // changed file) via the same /api/github proxy that the rest of this
  // page uses; subsequent toggles read from the in-component cache so
  // re-opening is instant.
  const toggleCommitDetail = useCallback(
    async (sha: string) => {
      let opened = false;
      setExpandedCommitShas((current) => {
        const next = new Set(current);
        if (next.has(sha)) {
          next.delete(sha);
        } else {
          next.add(sha);
          opened = true;
        }
        return next;
      });
      if (!opened) return;
      if (commitDetailBySha[sha]) return;

      setLoadingCommitShas((current) => new Set(current).add(sha));
      setErrorByCommitSha((current) => {
        const next = { ...current };
        delete next[sha];
        return next;
      });
      try {
        const data = await githubJson<CommitDetail>(
          `${API_BASE}/commits/${encodeURIComponent(sha)}`
        );
        setCommitDetailBySha((current) => ({ ...current, [sha]: data }));
      } catch (err) {
        setErrorByCommitSha((current) => ({
          ...current,
          [sha]:
            err instanceof Error ? err.message : "Could not load commit diff",
        }));
      } finally {
        setLoadingCommitShas((current) => {
          const next = new Set(current);
          next.delete(sha);
          return next;
        });
      }
    },
    [API_BASE, commitDetailBySha]
  );

  // Fetch the raw unified diff for a commit through the proxy's
  // `?media=diff` opt-in. Used when the JSON detail returned
  // `files[]` without a `patch` (large text files, >300 KB). Cached by
  // SHA so re-opening the full diff is instant.
  const loadFullDiff = useCallback(
    async (sha: string) => {
      if (fullDiffBySha[sha]) return;
      setLoadingFullDiffShas((current) => new Set(current).add(sha));
      setErrorFullDiffBySha((current) => {
        const next = { ...current };
        delete next[sha];
        return next;
      });
      try {
        const token = getAuthToken();
        const response = await fetch(
          `${API_BASE}/commits/${encodeURIComponent(sha)}?media=diff`,
          {
            credentials: "include",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }
        );
        if (!response.ok) {
          throw new Error(`GitHub diff failed (${response.status})`);
        }
        const text = await response.text();
        // Cap at ~2 MB so a runaway commit can't blow the browser tab —
        // GitHub itself caps the raw diff endpoint at a similar size.
        const capped =
          text.length > 2_000_000
            ? `${text.slice(0, 2_000_000)}\n\n…diff truncated; open on GitHub for the full patch`
            : text;
        setFullDiffBySha((current) => ({ ...current, [sha]: capped }));
      } catch (err) {
        setErrorFullDiffBySha((current) => ({
          ...current,
          [sha]:
            err instanceof Error ? err.message : "Could not load full diff",
        }));
      } finally {
        setLoadingFullDiffShas((current) => {
          const next = new Set(current);
          next.delete(sha);
          return next;
        });
      }
    },
    [API_BASE, fullDiffBySha]
  );

  // Toggle the run-detail flow inline. First open also fetches the
  // jobs (with steps embedded) and caches them keyed by run id so
  // re-toggling the same run doesn't re-hit GitHub's API.
  const toggleRunFlow = useCallback(
    async (run: WorkflowRun) => {
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
          `${API_BASE}/actions/runs/${run.id}/jobs?per_page=100`
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
    },
    [API_BASE, jobsByRunId]
  );

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
    void loadReadme(branch);
    void loadWorkflows(branch);
    void loadCommits(branch);
    // Actions list is now branch-agnostic (a push to any branch should
    // surface), so we only refresh it on the initial repo load and
    // reset per-run UI state at the same time. Run-detail caches stay
    // valid (keyed by run id, which is global).
    setRunsPage(1);
    setRunsTotal(0);
    setExpandedRunIds(new Set());
    setExpandedJobIds(new Set());
    void loadRuns(1, false);
  }, [branch, loadCommits, loadReadme, loadRuns, loadWorkflows, repo]);

  async function openFile(item: ContentItem) {
    setSelectedFile(item);
    setFileText("");
    if (!item.download_url) return;

    setFileLoading(true);
    try {
      const response = await fetch(item.download_url);
      if (!response.ok)
        throw new Error(`File request failed (${response.status})`);
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
            <span
              className={`github-tree-toggle ${isExpanded ? "open" : ""}`}
              aria-hidden="true"
            >
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
    return (
      <div className="github-page github-loading">Loading GitHub repo...</div>
    );
  }

  return (
    <div className="github-page">
      {error && (
        <div className="github-banner" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="github-banner-dismiss"
            onClick={() => setError("")}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      <div className="github-layout">
        {/* Left rail — split into two visually distinct card panels:
            (1) Branch picker, (2) Section nav. Mirrors the Emails-page
            sidebar pattern (account list + folder list) so the page
            feels at home with the rest of the app's chrome. */}
        <aside className="github-sidebar" aria-label="GitHub sections">
          {repoSwitcher}
          <div className="github-sidebar-card">
            <div className="github-sidebar-branch" ref={branchMenuRef}>
              <span className="github-sidebar-branch-label">Branch</span>
              <button
                type="button"
                className="github-branch-trigger"
                aria-haspopup="listbox"
                aria-expanded={branchMenuOpen}
                onClick={() => setBranchMenuOpen((open) => !open)}
              >
                <span className="github-branch-name">{branch}</span>
                <span
                  className={`github-branch-caret ${branchMenuOpen ? "open" : ""}`}
                  aria-hidden="true"
                >
                  ⌄
                </span>
              </button>
              {branchMenuOpen && (
                <ul
                  className="github-branch-menu"
                  role="listbox"
                  aria-label="Branches"
                >
                  {branches.map((item) => (
                    <li
                      key={item.name}
                      role="option"
                      aria-selected={item.name === branch}
                    >
                      <button
                        type="button"
                        className={`github-branch-option ${item.name === branch ? "active" : ""}`}
                        onClick={() => {
                          setBranch(item.name);
                          setBranchMenuOpen(false);
                        }}
                      >
                        <span className="github-branch-name">{item.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="github-sidebar-card">
            <button
              type="button"
              className={`github-sidebar-link ${activeSection === "description" ? "active" : ""}`}
              onClick={() => setActiveSection("description")}
            >
              <span className="github-sidebar-icon" aria-hidden="true">
                📖
              </span>
              <span className="github-sidebar-label">Description</span>
            </button>
            <button
              type="button"
              className={`github-sidebar-link ${activeSection === "files" ? "active" : ""}`}
              onClick={() => setActiveSection("files")}
            >
              <span className="github-sidebar-icon" aria-hidden="true">
                📁
              </span>
              <span className="github-sidebar-label">Files</span>
            </button>
            <button
              type="button"
              className={`github-sidebar-link ${activeSection === "workflows" ? "active" : ""}`}
              onClick={() => setActiveSection("workflows")}
            >
              <span className="github-sidebar-icon" aria-hidden="true">
                ⚙️
              </span>
              <span className="github-sidebar-label">Workflows</span>
              <span className="github-sidebar-count">{workflows.length}</span>
            </button>
            <button
              type="button"
              className={`github-sidebar-link ${activeSection === "commits" ? "active" : ""}`}
              onClick={() => setActiveSection("commits")}
            >
              <span className="github-sidebar-icon" aria-hidden="true">
                📝
              </span>
              <span className="github-sidebar-label">Commits</span>
              <span className="github-sidebar-count">{commits.length}</span>
            </button>
            <button
              type="button"
              className={`github-sidebar-link ${activeSection === "actions" ? "active" : ""}`}
              onClick={() => setActiveSection("actions")}
            >
              <span className="github-sidebar-icon" aria-hidden="true">
                ▶
              </span>
              <span className="github-sidebar-label">Actions</span>
              <span className="github-sidebar-count">{runs.length}</span>
            </button>
          </div>
        </aside>

        {/* Right pane — only the active section is rendered. The Files
            view keeps its existing 2-pane (tree + preview) layout
            because file browsing benefits from both being visible. */}
        <div className="github-content">
          {activeSection === "description" && (
            <main
              className="github-description"
              aria-label="Project description"
            >
              <section className="github-browser">
                <div className="github-panel-head">
                  <h2>{repo?.full_name ?? "Description"}</h2>
                  {repo?.visibility && (
                    <span className="github-panel-head-trail">
                      <span className="github-visibility-chip">
                        {repo.visibility}
                      </span>
                    </span>
                  )}
                </div>

                <p className="github-description-summary">
                  {repo?.description || "No description provided."}
                </p>

                {repo && (
                  <div className="github-description-meta">
                    {repo.language && <span>{repo.language}</span>}
                    <span>★ {repo.stargazers_count}</span>
                    <span>{repo.forks_count} forks</span>
                    <span>{repo.open_issues_count} open issues</span>
                    <span>
                      updated {new Date(repo.updated_at).toLocaleDateString()}
                    </span>
                  </div>
                )}

                {repo?.html_url && (
                  <a
                    className="github-description-link"
                    href={repo.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View on GitHub →
                  </a>
                )}

                <div className="github-panel-head github-description-readme-head">
                  <h2>README</h2>
                </div>
                {readmeLoading ? (
                  <div className="github-empty">Loading README…</div>
                ) : (
                  <pre className="github-description-readme">
                    {readme || "No README found."}
                  </pre>
                )}
              </section>
            </main>
          )}

          {activeSection === "files" && (
            // Progressive disclosure: until a file is opened, render the
            // file tree as a single full-width list. Once the user picks
            // a file, the layout splits to show files + preview side by
            // side. Closing the preview returns to the single-pane list.
            // In split mode the grid columns are driven inline so the
            // drag handle between tree and preview can resize live.
            <main
              className={`github-grid ${selectedFile ? "is-split" : "is-single"}`}
              style={
                selectedFile
                  ? {
                      gridTemplateColumns: `${filesPaneWidth}px 5px minmax(0, 1fr)`,
                    }
                  : undefined
              }
            >
              <section className="github-browser" aria-label="Repository files">
                <div className="github-panel-head">
                  <h2>Files</h2>
                </div>
                <div className="github-file-list">
                  {renderTree()}
                  {!loadingPaths.has("") &&
                    (treeItems[""] ?? []).length === 0 && (
                      <div className="github-empty">No files found.</div>
                    )}
                </div>
              </section>

              {selectedFile && (
                <div
                  className="github-grid-resize"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize files pane"
                  onPointerDown={handleFilesPaneResize}
                />
              )}

              {selectedFile && (
                <section className="github-preview" aria-label="File preview">
                  <div className="github-panel-head">
                    <h2>{selectedFile.name}</h2>
                    <span className="github-panel-head-trail">
                      <span>{formatSize(selectedFile.size)}</span>
                      <button
                        type="button"
                        className="github-preview-close"
                        onClick={() => {
                          setSelectedFile(null);
                          setFileText("");
                        }}
                        aria-label="Close file preview"
                        title="Close preview"
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                  {fileLoading ? (
                    <div className="github-empty">Loading file...</div>
                  ) : (
                    <pre>{fileText || "No preview available."}</pre>
                  )}
                </section>
              )}
            </main>
          )}

          {activeSection === "workflows" && (
            <div className="github-panel">
              <div className="github-panel-head">
                <h2>Workflows</h2>
                <span>{workflows.length}</span>
              </div>
              {workflows.map((workflow) => (
                <button
                  key={workflow.path}
                  type="button"
                  className={`github-workflow ${
                    selectedFile?.path === workflow.path ? "active" : ""
                  }`}
                  onClick={() => void openFile(workflow)}
                >
                  <span>{workflow.name}</span>
                  <small>{formatSize(workflow.size)}</small>
                </button>
              ))}
              {workflows.length === 0 && (
                <div className="github-empty">No workflows found.</div>
              )}

              {/* Preview the opened workflow file inline (the Workflows panel
                  has no split pane of its own, unlike Files). Guarded to a
                  workflow path so a file opened in the Files tab doesn't leak
                  in here. */}
              {selectedFile &&
                workflows.some((w) => w.path === selectedFile.path) && (
                  <section
                    className="github-preview github-workflow-preview"
                    aria-label="Workflow preview"
                  >
                    <div className="github-panel-head">
                      <h2>{selectedFile.name}</h2>
                      <span className="github-panel-head-trail">
                        <span>{formatSize(selectedFile.size)}</span>
                        <button
                          type="button"
                          className="github-preview-close"
                          onClick={() => {
                            setSelectedFile(null);
                            setFileText("");
                          }}
                          aria-label="Close workflow preview"
                          title="Close preview"
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                    {fileLoading ? (
                      <div className="github-empty">Loading file...</div>
                    ) : (
                      <pre>{fileText || "No preview available."}</pre>
                    )}
                  </section>
                )}
            </div>
          )}

          {activeSection === "commits" && (
            <div className="github-panel">
              <div className="github-panel-head">
                <h2>Commits</h2>
                <span>{commits.length}</span>
              </div>
              {commits.map((commit) => {
                const isOpen = expandedCommitShas.has(commit.sha);
                const isLoading = loadingCommitShas.has(commit.sha);
                const detail = commitDetailBySha[commit.sha];
                const errorText = errorByCommitSha[commit.sha];
                return (
                  <div key={commit.sha} className="github-commit-node">
                    <div className={`github-commit ${isOpen ? "is-open" : ""}`}>
                      <button
                        type="button"
                        className="github-commit-toggle"
                        onClick={() => void toggleCommitDetail(commit.sha)}
                        aria-expanded={isOpen}
                        aria-label={`Toggle changes for ${commit.sha.slice(0, 7)}`}
                      >
                        <span
                          className={`github-tree-toggle ${isOpen ? "open" : ""}`}
                          aria-hidden="true"
                        >
                          <ChevronIcon />
                        </span>
                        <span className="github-commit-main">
                          <strong>{firstLine(commit.commit.message)}</strong>
                          <small>
                            {commit.author?.login ??
                              commit.commit.author?.name ??
                              "Unknown"}
                            {" · "}
                            {commit.commit.author
                              ? formatDate(commit.commit.author.date)
                              : "Unknown"}
                            {detail?.stats && (
                              <>
                                {" · "}
                                <span className="github-commit-stat is-add">
                                  +{detail.stats.additions}
                                </span>{" "}
                                <span className="github-commit-stat is-del">
                                  −{detail.stats.deletions}
                                </span>
                              </>
                            )}
                          </small>
                        </span>
                        <code>{commit.sha.slice(0, 7)}</code>
                      </button>
                      <a
                        className="github-commit-open"
                        href={commit.html_url}
                        target="_blank"
                        rel="noreferrer"
                        title="Open on GitHub"
                        aria-label="Open on GitHub"
                        onClick={(event) => event.stopPropagation()}
                      >
                        ↗
                      </a>
                    </div>

                    {isOpen && (
                      <div className="github-commit-diff">
                        {isLoading && (
                          <div className="github-empty">Loading changes…</div>
                        )}
                        {errorText && (
                          <div className="github-banner">{errorText}</div>
                        )}
                        {!isLoading && !errorText && detail && (
                          <>
                            {(detail.files ?? []).map((file) => (
                              <article
                                key={file.filename}
                                className={`github-commit-file status-${file.status}`}
                              >
                                <header className="github-commit-file-head">
                                  <span className="github-commit-file-name">
                                    {file.previous_filename
                                      ? `${file.previous_filename} → ${file.filename}`
                                      : file.filename}
                                  </span>
                                  <span className="github-commit-file-meta">
                                    <em
                                      className={`github-commit-status status-${file.status}`}
                                    >
                                      {file.status}
                                    </em>
                                    <span className="github-commit-stat is-add">
                                      +{file.additions}
                                    </span>
                                    <span className="github-commit-stat is-del">
                                      −{file.deletions}
                                    </span>
                                  </span>
                                </header>
                                {file.patch ? (
                                  <pre className="github-commit-patch">
                                    {file.patch.split("\n").map((line, idx) => {
                                      let cls = "diff-ctx";
                                      if (line.startsWith("@@"))
                                        cls = "diff-hunk";
                                      else if (
                                        line.startsWith("+") &&
                                        !line.startsWith("+++")
                                      )
                                        cls = "diff-add";
                                      else if (
                                        line.startsWith("-") &&
                                        !line.startsWith("---")
                                      )
                                        cls = "diff-del";
                                      return (
                                        <span
                                          key={idx}
                                          className={`github-commit-patch-line ${cls}`}
                                        >
                                          {line || " "}
                                        </span>
                                      );
                                    })}
                                  </pre>
                                ) : (
                                  <div className="github-commit-nopatch">
                                    Binary file or diff not available — open on
                                    GitHub to view.
                                  </div>
                                )}
                              </article>
                            ))}
                            {(detail.files ?? []).length === 0 && (
                              <div className="github-empty">
                                This commit has no file changes recorded.
                              </div>
                            )}

                            {/* Fallback: when ANY file in the JSON detail
                                has no patch (GitHub omits patches over
                                ~300 KB), surface a button that fetches
                                the raw unified diff through the proxy's
                                `?media=diff` branch. Hidden once we've
                                already loaded the raw diff for this SHA. */}
                            {(() => {
                              const hasMissingPatch = (detail.files ?? []).some(
                                (file) =>
                                  !file.patch &&
                                  file.status !== "added" &&
                                  file.status !== "removed"
                              );
                              const rawDiff = fullDiffBySha[commit.sha];
                              const fullLoading = loadingFullDiffShas.has(
                                commit.sha
                              );
                              const fullError = errorFullDiffBySha[commit.sha];
                              if (!hasMissingPatch && !rawDiff) return null;
                              return (
                                <div className="github-commit-fulldiff">
                                  {!rawDiff && (
                                    <button
                                      type="button"
                                      className="github-commit-fulldiff-btn"
                                      onClick={() =>
                                        void loadFullDiff(commit.sha)
                                      }
                                      disabled={fullLoading}
                                    >
                                      {fullLoading
                                        ? "Loading full diff…"
                                        : "Load full diff"}
                                    </button>
                                  )}
                                  {fullError && (
                                    <div className="github-banner">
                                      {fullError}
                                    </div>
                                  )}
                                  {rawDiff && (
                                    <pre className="github-commit-patch is-full">
                                      {rawDiff.split("\n").map((line, idx) => {
                                        let cls = "diff-ctx";
                                        if (line.startsWith("diff --git"))
                                          cls = "diff-file";
                                        else if (line.startsWith("@@"))
                                          cls = "diff-hunk";
                                        else if (
                                          line.startsWith("+++") ||
                                          line.startsWith("---")
                                        )
                                          cls = "diff-file-marker";
                                        else if (
                                          line.startsWith("+") &&
                                          !line.startsWith("+++")
                                        )
                                          cls = "diff-add";
                                        else if (
                                          line.startsWith("-") &&
                                          !line.startsWith("---")
                                        )
                                          cls = "diff-del";
                                        return (
                                          <span
                                            key={idx}
                                            className={`github-commit-patch-line ${cls}`}
                                          >
                                            {line || " "}
                                          </span>
                                        );
                                      })}
                                    </pre>
                                  )}
                                </div>
                              );
                            })()}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {commits.length === 0 && (
                <div className="github-empty">No commits found.</div>
              )}
            </div>
          )}

          {activeSection === "actions" && (
            <div className="github-panel">
              <div className="github-panel-head">
                <div className="github-actions-head-main">
                  <h2>Actions</h2>
                  <small className="github-actions-scope-note">
                    Showing runs from all workflows
                  </small>
                </div>
                <span>
                  {/* Show "loaded / total" so the user can see how much
                      history is still available behind "Load more". When
                      the API hasn't returned a total yet, just show the
                      loaded count. */}
                  {runsTotal > 0 && runsTotal > runs.length
                    ? `${runs.length} of ${runsTotal}`
                    : runs.length}
                </span>
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
                        <span className="github-actions-name">
                          {group.name}
                        </span>
                        <span className="github-actions-count">
                          {group.runs.length}{" "}
                          {group.runs.length === 1 ? "run" : "runs"}
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
                              <div
                                key={run.id}
                                className="github-actions-run-node"
                                role="listitem"
                              >
                                <button
                                  type="button"
                                  className={`github-actions-row is-run ${isOpen ? "is-open" : ""}`}
                                  onClick={() => void toggleRunFlow(run)}
                                  aria-expanded={isOpen}
                                  aria-label={`Toggle ${run.display_title} run details`}
                                >
                                  <span
                                    className="github-actions-rail"
                                    aria-hidden="true"
                                  />
                                  <span
                                    className={`github-status-dot status-${state}`}
                                    aria-hidden="true"
                                  />
                                  <span className="github-actions-run-main">
                                    <strong>{run.display_title}</strong>
                                    <small>
                                      {run.head_branch}
                                      {" · "}
                                      {formatDate(
                                        run.updated_at ?? run.created_at
                                      )}
                                    </small>
                                  </span>
                                  <em
                                    className={`github-actions-state ${state}`}
                                  >
                                    {state}
                                  </em>
                                </button>

                                {isOpen && (
                                  <div className="github-flow github-flow-inline">
                                    {isLoading && (
                                      <div className="github-flow-empty">
                                        Loading jobs…
                                      </div>
                                    )}

                                    {runError && (
                                      <div className="github-banner">
                                        {runError}
                                      </div>
                                    )}

                                    {!isLoading &&
                                      !runError &&
                                      runJobs.length === 0 && (
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
                                          const jobState =
                                            job.conclusion ??
                                            job.status ??
                                            "unknown";
                                          const isJobOpen = expandedJobIds.has(
                                            job.id
                                          );
                                          return (
                                            <article
                                              key={job.id}
                                              className={`github-flow-job state-${jobState} ${isJobOpen ? "is-open" : ""}`}
                                            >
                                              <button
                                                type="button"
                                                className="github-flow-job-head"
                                                onClick={() => {
                                                  setExpandedJobIds(
                                                    (current) => {
                                                      const next = new Set(
                                                        current
                                                      );
                                                      if (next.has(job.id))
                                                        next.delete(job.id);
                                                      else next.add(job.id);
                                                      return next;
                                                    }
                                                  );
                                                }}
                                                aria-expanded={isJobOpen}
                                              >
                                                <span
                                                  className={`github-tree-toggle ${isJobOpen ? "open" : ""}`}
                                                  aria-hidden="true"
                                                >
                                                  <ChevronIcon />
                                                </span>
                                                <StatusIcon state={jobState} />
                                                <span className="github-flow-job-title">
                                                  <strong>{job.name}</strong>
                                                  <small>
                                                    {formatDuration(
                                                      job.started_at,
                                                      job.completed_at
                                                    )}
                                                    {job.runner_name
                                                      ? ` · ${job.runner_name}`
                                                      : ""}
                                                  </small>
                                                </span>
                                                <a
                                                  className="github-flow-job-link"
                                                  href={job.html_url}
                                                  target="_blank"
                                                  rel="noreferrer"
                                                  aria-label={`Open ${job.name} on GitHub`}
                                                  title="Open on GitHub"
                                                  onClick={(event) =>
                                                    event.stopPropagation()
                                                  }
                                                >
                                                  ↗
                                                </a>
                                              </button>

                                              {isJobOpen && (
                                                <ol className="github-flow-steps">
                                                  {job.steps
                                                    .slice()
                                                    .sort(
                                                      (a, b) =>
                                                        a.number - b.number
                                                    )
                                                    .map((step) => {
                                                      const stepState =
                                                        step.conclusion ??
                                                        step.status ??
                                                        "unknown";
                                                      return (
                                                        <li
                                                          key={`${job.id}-${step.number}`}
                                                          className="github-flow-step"
                                                        >
                                                          <span
                                                            className="github-tree-toggle"
                                                            aria-hidden="true"
                                                          >
                                                            <ChevronIcon />
                                                          </span>
                                                          <StatusIcon
                                                            state={stepState}
                                                          />
                                                          <span className="github-flow-step-name">
                                                            {step.name}
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
                                              )}
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
                {runs.length === 0 && (
                  <div className="github-empty">No runs found.</div>
                )}

                {/* "Load more" — fetches the next page of workflow_runs
                filtered to the current branch. Hidden when we've
                already loaded everything GitHub knows about, or when
                the initial fetch hasn't returned a total yet. */}
                {runsTotal > runs.length && (
                  <div className="github-actions-load-more">
                    <button
                      type="button"
                      onClick={() => void loadRuns(runsPage + 1, true)}
                      disabled={runsLoadingMore}
                    >
                      {runsLoadingMore
                        ? "Loading…"
                        : `Load more (${runsTotal - runs.length} remaining)`}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Paste-a-URL panel shown when a project has no repo linked yet. `canLink`
// gates the input: a personal owner or an org owner sees it; a plain org member
// gets a read-only "ask your owner" message (the backend would 403 them anyway).
function AddRepoPanel({
  project,
  onLinked,
  canLink = true,
}: {
  project: Project;
  onLinked: () => void;
  canLink?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (!canLink) {
    return (
      <div className="github-page github-empty-state">
        <div className="github-add-repo">
          <h2 className="github-add-repo-title">No repository linked</h2>
          <p className="github-add-repo-help">
            “{project.name}” doesn’t have a repository yet. Ask an organization
            owner to link one from the sidebar.
          </p>
        </div>
      </div>
    );
  }

  const submit = () => {
    const value = url.trim();
    if (!value || busy) return;
    setBusy(true);
    setErr("");
    void linkProjectRepo(project.id, value)
      .then(() => onLinked())
      .catch((e) =>
        setErr(e instanceof Error ? e.message : "Failed to link repository")
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="github-page github-empty-state">
      <div className="github-add-repo">
        <h2 className="github-add-repo-title">Add a repository</h2>
        <p className="github-add-repo-help">
          Paste a public GitHub repository URL to browse its code, commits and
          Actions in “{project.name}”.
        </p>
        <div className="github-add-repo-row">
          <input
            className="github-add-repo-input"
            type="text"
            value={url}
            placeholder="https://github.com/owner/repo"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            disabled={busy}
            autoFocus
          />
          <button
            type="button"
            className="github-add-repo-btn"
            onClick={submit}
            disabled={busy || !url.trim()}
          >
            {busy ? "Adding…" : "Add repository"}
          </button>
        </div>
        {err && <p className="github-add-repo-error">{err}</p>}
      </div>
    </div>
  );
}

// Resolves a personal account's project (by route id) to its linked repo, then
// renders the viewer. Handles loading / not-found / no-repo-yet states.
function GitHubRepoProject({
  projectId,
  repoSwitcher,
  canLink = true,
}: {
  projectId: number;
  repoSwitcher?: ReactNode;
  canLink?: boolean;
}) {
  const [project, setProject] = useState<Project | "missing" | null>(null);
  const [loading, setLoading] = useState(true);

  // Note: no synchronous setState here (would trip react-hooks/set-state-in-
  // effect). `loading` starts true; we only flip it false when the fetch
  // settles. The wrapper is keyed by projectId so each project mounts fresh.
  const reload = useCallback(() => {
    void listProjects()
      .then((rows) => {
        const found = rows.find((r) => r.id === projectId);
        setProject(found ?? "missing");
      })
      .catch(() => setProject("missing"))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (loading && project === null) {
    return (
      <div className="github-page github-empty-state">
        <p className="github-empty">Loading project…</p>
      </div>
    );
  }
  if (project === "missing" || project === null) {
    return (
      <div className="github-page github-empty-state">
        <p className="github-empty">Project not found.</p>
      </div>
    );
  }
  if (!project.github_owner || !project.github_repo) {
    return (
      <AddRepoPanel project={project} onLinked={reload} canLink={canLink} />
    );
  }
  return (
    <GitHubRepoViewer
      key={`${project.github_owner}/${project.github_repo}`}
      owner={project.github_owner}
      repo={project.github_repo}
      repoSwitcher={repoSwitcher}
    />
  );
}

// Display label for a project tab: "owner/repo" once linked, else its name.
function repoLabel(p: Project): string {
  return p.github_owner && p.github_repo
    ? `${p.github_owner}/${p.github_repo}`
    : p.name;
}

// Derive a project name from a pasted repo URL (the repo segment), so a
// personal user only has to paste the URL — no separate "name" field.
function repoNameFromUrl(raw: string): string {
  const cleaned = raw.trim().replace(/\.git$/, "");
  const match = cleaned.match(/([^/:]+)\/([^/]+)\/?$/);
  return match ? match[2] : cleaned;
}

// In-page repo manager for personal accounts at the bare `/github` route. The
// repo selector (dropdown + Add) renders inside the viewer's left rail, ABOVE
// the Branch block, via the `repoSwitcher` prop. No sidebar involvement.
function PersonalRepoManager() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // No synchronous setState in the effect (react-hooks/set-state-in-effect):
  // listProjects resolves asynchronously and only then sets state.
  useEffect(() => {
    void listProjects()
      .then((rows) => {
        setProjects(rows);
        setSelectedId((cur) =>
          cur && rows.some((r) => r.id === cur) ? cur : (rows[0]?.id ?? null)
        );
      })
      .catch(() => setProjects([]));
  }, []);

  const submitAdd = () => {
    const value = url.trim();
    if (!value || busy) return;
    setBusy(true);
    setErr("");
    void createProject(repoNameFromUrl(value), value)
      .then((created) => {
        setProjects((prev) => (prev ? [created, ...prev] : [created]));
        setSelectedId(created.id);
        setUrl("");
        setAdding(false);
      })
      .catch((e) =>
        setErr(e instanceof Error ? e.message : "Failed to add repository")
      )
      .finally(() => setBusy(false));
  };

  const hasRepos = (projects?.length ?? 0) > 0;

  // Repo selector card injected at the top of the viewer's left rail (above
  // Branch): the dropdown of the user's repos + an Add button below it.
  const switcher = (
    <div className="github-sidebar-card github-repo-switch">
      <span className="github-sidebar-branch-label">Repository</span>
      <select
        className="github-repo-switch-select"
        value={selectedId ?? ""}
        onChange={(e) => setSelectedId(Number(e.target.value))}
        aria-label="Select a repository"
      >
        {projects?.map((p) => (
          <option key={p.id} value={p.id}>
            {repoLabel(p)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="github-add-repo-btn github-repo-switch-add"
        onClick={() => {
          setErr("");
          setUrl("");
          setAdding((a) => !a);
        }}
      >
        {adding ? "Cancel" : "+ Add"}
      </button>
      {adding && (
        <div className="github-repo-switch-form">
          <input
            className="github-add-repo-input"
            type="text"
            value={url}
            placeholder="https://github.com/owner/repo"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitAdd();
            }}
            disabled={busy}
            autoFocus
          />
          <button
            type="button"
            className="github-add-repo-btn"
            onClick={submitAdd}
            disabled={busy || !url.trim()}
          >
            {busy ? "Adding…" : "Add repository"}
          </button>
          {err && <p className="github-add-repo-error">{err}</p>}
        </div>
      )}
    </div>
  );

  // No repos yet → centered first-repo panel (there's no viewer rail to host
  // the switcher in until a repo exists).
  if (!hasRepos) {
    return (
      <div className="github-page github-empty-state">
        <div className="github-add-repo">
          <h2 className="github-add-repo-title">Add a repository</h2>
          <p className="github-add-repo-help">
            Paste a public GitHub repository URL to browse its code, commits and
            Actions here.
          </p>
          <div className="github-add-repo-row">
            <input
              className="github-add-repo-input"
              type="text"
              value={url}
              placeholder="https://github.com/owner/repo"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAdd();
              }}
              disabled={busy}
              autoFocus
            />
            <button
              type="button"
              className="github-add-repo-btn"
              onClick={submitAdd}
              disabled={busy || !url.trim()}
            >
              {busy ? "Adding…" : "Add repository"}
            </button>
          </div>
          {err && <p className="github-add-repo-error">{err}</p>}
        </div>
      </div>
    );
  }

  if (selectedId == null) return null;
  return (
    <GitHubRepoProject
      key={selectedId}
      projectId={selectedId}
      repoSwitcher={switcher}
    />
  );
}

// In-page repo manager for organization accounts at the bare `/github` route.
// Lists the org's projects in a switcher (above the Branch block) and renders
// the selected project's linked repo. Linking itself is owner-only and lives in
// the sidebar project menu; here `canLink` only decides whether an unlinked
// project shows the link form or a read-only hint.
function OrgRepoManager({ canLink }: { canLink: boolean }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    void listProjects()
      .then((rows) => {
        setProjects(rows);
        setSelectedId((cur) =>
          cur && rows.some((r) => r.id === cur) ? cur : (rows[0]?.id ?? null)
        );
      })
      .catch(() => setProjects([]));
  }, []);

  if (projects === null) {
    return (
      <div className="github-page github-empty-state">
        <p className="github-empty">Loading projects…</p>
      </div>
    );
  }
  if (projects.length === 0) {
    return (
      <div className="github-page github-empty-state">
        <div className="github-add-repo">
          <h2 className="github-add-repo-title">No projects yet</h2>
          <p className="github-add-repo-help">
            {canLink
              ? "Create a project from the sidebar, then use its menu to link a public repository."
              : "An organization owner can create a project and link a repository from the sidebar."}
          </p>
        </div>
      </div>
    );
  }
  if (selectedId == null) return null;

  const switcher = (
    <div className="github-sidebar-card github-repo-switch">
      <span className="github-sidebar-branch-label">Repository</span>
      <select
        className="github-repo-switch-select"
        value={selectedId}
        onChange={(e) => setSelectedId(Number(e.target.value))}
        aria-label="Select a repository"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {repoLabel(p)}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <GitHubRepoProject
      key={selectedId}
      projectId={selectedId}
      repoSwitcher={switcher}
      canLink={canLink}
    />
  );
}

// One row of GitHub's `/user/repos` list.
type RepoListItem = {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
};

// Platform Code Repo dashboard. Lists every repository the server token can see
// (above the Branch block, via the viewer's repoSwitcher slot) and lets the
// user switch which one the dashboard shows. Defaults to the fluxze repo so the
// page looks unchanged on first load; falls back to just that repo (no switcher)
// if the list can't be fetched.
function PlatformRepoManager() {
  // Deep-link support: the Projects page opens a repo via ?owner=&repo=.
  const [searchParams] = useSearchParams();
  const [repos, setRepos] = useState<RepoListItem[] | null>(null);
  const [selected, setSelected] = useState<{ owner: string; repo: string }>({
    owner: searchParams.get("owner") || FALLBACK_OWNER,
    repo: searchParams.get("repo") || FALLBACK_REPO,
  });

  useEffect(() => {
    void githubJson<RepoListItem[]>(
      "/api/github/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member"
    )
      .then((rows) => setRepos(Array.isArray(rows) ? rows : []))
      .catch(() => setRepos([]));
  }, []);

  const selectedFullName = `${selected.owner}/${selected.repo}`;
  const hasRepos = (repos?.length ?? 0) > 0;

  // Repo selector card injected at the top of the viewer's left rail, above the
  // Branch block. Listed by full owner/repo name; selecting one remounts the
  // viewer (it's keyed by owner/repo below).
  const switcher = hasRepos ? (
    <div className="github-sidebar-card github-repo-switch">
      <span className="github-sidebar-branch-label">Repository</span>
      <select
        className="github-repo-switch-select"
        value={selectedFullName}
        onChange={(e) => {
          const hit = repos?.find((r) => r.full_name === e.target.value);
          if (hit) setSelected({ owner: hit.owner.login, repo: hit.name });
        }}
        aria-label="Select a repository"
      >
        {/* Show just the repo name (not owner/repo); the option value keeps the
            full name so the onChange lookup still resolves owner + repo.
            Keep the current/default repo selectable even if the list doesn't
            include it (e.g. the token can read but not enumerate it). */}
        {repos?.some((r) => r.full_name === selectedFullName) ? null : (
          <option value={selectedFullName}>{selected.repo}</option>
        )}
        {repos?.map((r) => (
          <option key={r.full_name} value={r.full_name}>
            {r.name}
          </option>
        ))}
      </select>
    </div>
  ) : undefined;

  return (
    <GitHubRepoViewer
      key={selectedFullName}
      owner={selected.owner}
      repo={selected.repo}
      repoSwitcher={switcher}
    />
  );
}

// Route entry. `/github/:projectId` browses one project's repo. The bare
// `/github` gives personal accounts the in-page repo manager, and the platform
// team a multi-repo dashboard (repo switcher above the Branch block).
export default function GitHubRepo() {
  const { user } = useAuth();
  const { projectId } = useParams<{ projectId?: string }>();
  // Guests can't see code files — show a plain access message instead.
  if (user?.effective_role === "guest") {
    return (
      <div
        className="github-empty-state"
        style={{ height: "100%", padding: 40 }}
      >
        <p className="github-empty">Don&apos;t have access</p>
      </div>
    );
  }
  const isOrg = user?.scope === "organization";
  const isPersonal = user?.account_type === "personal";
  // Who may LINK a repo: a personal account (own projects) or an org owner.
  // Everyone else who can reach this page is read-only.
  const canLink = isPersonal || (isOrg && user?.effective_role === "owner");
  if (projectId) {
    return (
      <GitHubRepoProject
        key={projectId}
        projectId={Number(projectId)}
        canLink={canLink}
      />
    );
  }
  if (isPersonal) {
    return <PersonalRepoManager />;
  }
  if (isOrg) {
    return <OrgRepoManager canLink={canLink} />;
  }
  return <PlatformRepoManager />;
}
