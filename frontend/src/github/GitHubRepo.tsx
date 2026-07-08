import { Fragment, useCallback, useEffect, useRef, useState } from "react";
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
import {
  approvePullRequest,
  mergePullRequest,
  createCommitComment,
  listImportableRepos,
  getGithubConnection,
  getGithubConnectUrl,
  disconnectGithub,
  type MergeMethod,
} from "../api/github";
import "./githubRepo.css";

// Bulk-import every repository the connected GitHub token can see — one project
// per repo — skipping any already linked to an existing project (deduped by
// `owner/repo`). Best-effort: a repo that fails to link is skipped rather than
// aborting the whole import. `onProgress` reports how many have been created so
// the button can show a running count. Returns the newly created projects.
async function importAllRepos(
  existing: Project[],
  onProgress?: (done: number) => void
): Promise<Project[]> {
  const { connected, repos } = await listImportableRepos();
  if (!connected) {
    // Personal account with no GitHub connected — nothing to import.
    throw new Error("Connect your GitHub account to import your repositories.");
  }
  const alreadyLinked = new Set(
    existing
      .filter((p) => p.github_owner && p.github_repo)
      .map((p) => `${p.github_owner}/${p.github_repo}`.toLowerCase())
  );
  const toAdd = repos.filter(
    (r) => !alreadyLinked.has(r.full_name.toLowerCase())
  );
  const created: Project[] = [];
  for (const repo of toAdd) {
    try {
      created.push(
        await createProject(repo.name, `https://github.com/${repo.full_name}`)
      );
    } catch {
      // Skip a repo that fails to link (transient error / permission); the
      // rest of the import still proceeds.
    }
    onProgress?.(created.length);
  }
  return created;
}

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

// ── Split (side-by-side) diff rendering ─────────────────────────────
//
// Parse a GitHub per-file unified `patch` into paired left/right rows so the
// commit view renders old vs new in two columns (GitHub's "Split" view).
// Within a change block consecutive removals are paired row-for-row with the
// additions that follow; any overhang gets an empty cell on the opposite side.
// Context lines appear on both sides; `@@` hunk headers span the full width.
//
// GitHub's `files[].patch` is pure hunk content (no `diff --git`/`---`/`+++`
// file headers — those only appear in raw diffs), so a leading `-`/`+` is
// always real content. The only non-content line we drop is the
// `\ No newline at end of file` marker.
type SplitCell = {
  no: number | null;
  text: string;
  kind: "add" | "del" | "ctx" | "empty";
};
type SplitRow =
  | { type: "hunk"; text: string }
  | { type: "pair"; left: SplitCell; right: SplitCell };

const EMPTY_CELL: SplitCell = { no: null, text: "", kind: "empty" };

function toSplitRows(patch: string): SplitRow[] {
  const rows: SplitRow[] = [];
  let oldLn = 0;
  let newLn = 0;
  let dels: SplitCell[] = [];
  let adds: SplitCell[] = [];

  // Pair the buffered removals/additions of one change block, then reset.
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      rows.push({
        type: "pair",
        left: dels[i] ?? EMPTY_CELL,
        right: adds[i] ?? EMPTY_CELL,
      });
    }
    dels = [];
    adds = [];
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      flush();
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldLn = Number(m[1]);
        newLn = Number(m[2]);
      }
      rows.push({ type: "hunk", text: line });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — annotation, not a content line.
      continue;
    } else if (line.startsWith("+")) {
      adds.push({ no: newLn++, text: line.slice(1), kind: "add" });
    } else if (line.startsWith("-")) {
      dels.push({ no: oldLn++, text: line.slice(1), kind: "del" });
    } else {
      // Context line (leading space, or a blank line in the patch): flush the
      // pending change block first so removals/additions stay grouped.
      flush();
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({
        type: "pair",
        left: { no: oldLn++, text, kind: "ctx" },
        right: { no: newLn++, text, kind: "ctx" },
      });
    }
  }
  flush();
  return rows;
}

function CommitSplitPatch({ patch }: { patch: string }) {
  const rows = toSplitRows(patch);
  return (
    <div className="github-split">
      {rows.map((row, idx) =>
        row.type === "hunk" ? (
          <div key={idx} className="github-split-hunk">
            {row.text}
          </div>
        ) : (
          <Fragment key={idx}>
            <span className="github-split-no">{row.left.no ?? ""}</span>
            <span className={`github-split-code is-${row.left.kind}`}>
              {row.left.text || " "}
            </span>
            <span className="github-split-no">{row.right.no ?? ""}</span>
            <span className={`github-split-code is-${row.right.kind}`}>
              {row.right.text || " "}
            </span>
          </Fragment>
        )
      )}
    </div>
  );
}

// ── Pull request detail ─────────────────────────────────────────────
//
// The PR list (GitHubPull) only carries enough to render a row. Opening a
// PR fetches these richer shapes through the same read-only proxy:
//   * PullDetail   — /pulls/{n}              (body, +/− stats, head.sha, …)
//   * CommitFile   — /pulls/{n}/files        (identical shape to commit
//                                             files, so CommitSplitPatch
//                                             renders them as-is)
//   * IssueComment — /issues/{n}/comments    (the conversation comments)
//   * PullReview   — /pulls/{n}/reviews      (approvals / change requests)
//   * CheckRun     — /commits/{sha}/check-runs (CI status for head.sha)
type PullDetail = {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft?: boolean;
  merged?: boolean;
  body: string | null;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  created_at: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  labels?: Array<{ name: string }>;
  requested_reviewers?: Array<{ login: string }>;
  // GitHub computes mergeability asynchronously on the single-PR endpoint:
  // `mergeable` is null until ready, then true / false (conflicts).
  // `mergeable_state` is "clean" | "dirty" | "unstable" | "blocked" | "draft" | …
  mergeable?: boolean | null;
  mergeable_state?: string;
};

type IssueComment = {
  id: number;
  user: { login: string } | null;
  body: string | null;
  created_at: string;
};

type PullReview = {
  id: number;
  user: { login: string } | null;
  body: string | null;
  // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  state: string;
  submitted_at: string | null;
};

type CheckRun = {
  id: number;
  name: string;
  // queued | in_progress | completed
  status: string;
  // success | failure | neutral | cancelled | skipped | timed_out | …
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
};

type CheckRunsResponse = {
  total_count: number;
  check_runs: CheckRun[];
};

// Everything we cache for one opened PR, fetched together so the detail
// view renders in a single pass (mirrors commitDetailBySha for commits).
type PullBundle = {
  detail: PullDetail;
  files: CommitFile[];
  comments: IssueComment[];
  reviews: PullReview[];
  checks: CheckRun[];
};

// Comments and reviews merged into one chronological conversation.
// `reviewState` is set only on review entries (drives the verdict badge).
type TimelineEntry = {
  key: string;
  author: string;
  body: string;
  ts: string;
  reviewState?: string;
};

// Status pill for a PR: merged / closed / draft / open (in that priority).
function pullStatus(d: {
  state: string;
  draft?: boolean;
  merged?: boolean;
}): { label: string; cls: string } {
  if (d.merged) return { label: "Merged", cls: "is-merged" };
  if (d.state === "closed") return { label: "Closed", cls: "is-closed" };
  if (d.draft) return { label: "Draft", cls: "is-draft" };
  return { label: "Open", cls: "is-open" };
}

// Icon + label + class for one CI check run.
function checkVisual(c: CheckRun): { icon: string; label: string; cls: string } {
  if (c.status !== "completed") {
    return { icon: "•", label: "Running", cls: "is-pending" };
  }
  switch (c.conclusion) {
    case "success":
      return { icon: "✓", label: "Passed", cls: "is-pass" };
    case "failure":
    case "timed_out":
    case "action_required":
      return { icon: "✕", label: "Failed", cls: "is-fail" };
    default:
      // neutral / skipped / cancelled / stale
      return { icon: "–", label: c.conclusion ?? "—", cls: "is-neutral" };
  }
}

// Badge for a review's verdict in the discussion timeline.
function reviewBadge(state: string): { label: string; cls: string } {
  switch (state) {
    case "APPROVED":
      return { label: "Approved", cls: "is-approved" };
    case "CHANGES_REQUESTED":
      return { label: "Changes requested", cls: "is-changes" };
    case "DISMISSED":
      return { label: "Dismissed", cls: "is-neutral" };
    default:
      return { label: "Commented", cls: "is-neutral" };
  }
}

// Render a raw unified diff (the `?media=diff` fallback) with per-line
// coloring — the same treatment the commit full-diff uses.
function RawUnifiedDiff({ text }: { text: string }) {
  return (
    <pre className="github-commit-patch is-full">
      {text.split("\n").map((line, idx) => {
        let cls = "diff-ctx";
        if (line.startsWith("diff --git")) cls = "diff-file";
        else if (line.startsWith("@@")) cls = "diff-hunk";
        else if (line.startsWith("+++") || line.startsWith("---"))
          cls = "diff-file-marker";
        else if (line.startsWith("+")) cls = "diff-add";
        else if (line.startsWith("-")) cls = "diff-del";
        return (
          <span key={idx} className={`github-commit-patch-line ${cls}`}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

// Initials for an avatar chip: first letters of the first two word-parts
// (split on spaces and hyphens), else the first two characters.
function initials(name: string): string {
  const parts = name.trim().split(/[\s-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.slice(0, 2) || "?").toUpperCase();
}

// A small initials avatar (no network image — works offline and avoids
// broken-image flashes; mirrors the mockup's MK / GB chips).
function PrAvatar({ name }: { name: string }) {
  return (
    <span className="github-pr-avatar" aria-hidden="true">
      {initials(name)}
    </span>
  );
}

// Lightweight inline rendering for PR/comment text: `backtick` spans become
// <code> chips and bare http(s) URLs become links. Newlines are preserved by
// the container's `white-space: pre-wrap`. Not a full markdown renderer —
// just the two affordances the PR view needs.
function renderRichText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split(/(`[^`]+`)/g).forEach((seg, i) => {
    if (seg.length >= 2 && seg.startsWith("`") && seg.endsWith("`")) {
      out.push(
        <code key={`c${i}`} className="github-pr-code">
          {seg.slice(1, -1)}
        </code>
      );
      return;
    }
    seg.split(/(https?:\/\/[^\s]+)/g).forEach((part, j) => {
      if (!part) return;
      if (/^https?:\/\//.test(part)) {
        out.push(
          <a
            key={`u${i}-${j}`}
            className="github-pr-textlink"
            href={part}
            target="_blank"
            rel="noreferrer"
          >
            {part}
          </a>
        );
      } else {
        out.push(<span key={`t${i}-${j}`}>{part}</span>);
      }
    });
  });
  return out;
}

type RunsResponse = {
  workflow_runs: WorkflowRun[];
  total_count: number;
};

// How many runs we pull per `/actions/runs` page. 50 matches GitHub's
// own "453 workflow runs" view density without blowing past the
// API's 100/page max. The "Load more" affordance pages further if the
// repo has more than this.
const RUNS_PER_PAGE = 50;

// Commits page size. The Commits tab pages through the full branch history
// 25-at-a-time (Prev/Next) rather than showing just the latest few.
const COMMITS_PER_PAGE = 25;

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

  // A 200 that doesn't parse to an object/array means something upstream
  // returned an unexpected body (e.g. an HTML page from a misrouted request
  // or a literal `null`). Treat it as an error so callers surface a banner
  // instead of silently resolving to a falsy value that renders as a blank.
  const data = (await response.json()) as unknown;
  if (data === null || typeof data !== "object") {
    throw new Error("GitHub returned an unexpected response.");
  }
  return data as T;
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

  // Pull Requests are owner-only across every scope (personal / organization /
  // enterprise / platform). The backend proxy enforces this on the `pulls`
  // (and PR-comment `issues`) paths; here we just hide the tab so non-owners
  // never see it or fire 403 fetches. `effective_role === "owner"` mirrors the
  // backend's `Role::Owner` for all scopes (personal accounts resolve to owner).
  const { user } = useAuth();
  const isOwner = user?.effective_role === "owner";
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
  // Commits pagination. GitHub's /commits returns no total, so we read the
  // proxy-forwarded Link header to get the grand total (see loadCommitsTotal).
  const [commitsPage, setCommitsPage] = useState(1);
  const [commitsHasMore, setCommitsHasMore] = useState(false);
  const [commitsLoading, setCommitsLoading] = useState(false);
  // Total commits on the branch (null = unknown). Derived from the `rel="last"`
  // page of a `per_page=1` request's Link header.
  const [commitsTotal, setCommitsTotal] = useState<number | null>(null);
  // Open pull requests (read-only). Merging happens on github.com via each
  // PR's html_url — the proxy is GET-only and the shared token has no write
  // access to linked public repos.
  const [pulls, setPulls] = useState<GitHubPull[]>([]);
  const [pullsLoading, setPullsLoading] = useState(false);
  const [pullsError, setPullsError] = useState("");
  // Which PR states to show. We fetch open + closed together (state=all) and
  // filter client-side, defaulting to "open" — the Closed button switches over.
  const [pullFilter, setPullFilter] = useState<"open" | "closed">("open");
  // Master ⇄ detail for the Pull Requests tab. `selectedPull` is the open
  // PR number (null = list view). Each opened PR's detail + files +
  // conversation + checks are fetched together and cached by number so
  // re-opening is instant (mirrors commitDetailBySha).
  const [selectedPull, setSelectedPull] = useState<number | null>(null);
  const [pullBundleByNumber, setPullBundleByNumber] = useState<
    Record<number, PullBundle>
  >({});
  const [loadingPullNumbers, setLoadingPullNumbers] = useState<Set<number>>(
    new Set()
  );
  const [errorByPullNumber, setErrorByPullNumber] = useState<
    Record<number, string>
  >({});
  // Raw unified-diff fallback for a PR (via ?media=diff), keyed by PR
  // number — same opt-in the commit view uses when patches are omitted.
  const [pullFullDiff, setPullFullDiff] = useState<Record<number, string>>({});
  const [pullFullDiffLoading, setPullFullDiffLoading] = useState<Set<number>>(
    new Set()
  );
  const [pullFullDiffError, setPullFullDiffError] = useState<
    Record<number, string>
  >({});
  // PR detail view chrome: whether the long description is expanded, and which
  // collapsible sections (discussion / files / details / checks) are closed.
  const [descExpanded, setDescExpanded] = useState(false);
  const [collapsedPrSections, setCollapsedPrSections] = useState<Set<string>>(
    new Set()
  );
  // PR approval (owner-only write). `approvingPull` is the number mid-request;
  // `approvedPulls` reflects a successful approve optimistically (the proxied
  // reviews list stays cached for the TTL); errors carry GitHub's own message.
  const [approvingPull, setApprovingPull] = useState<number | null>(null);
  const [approvedPulls, setApprovedPulls] = useState<Set<number>>(new Set());
  const [approveErrorByPull, setApproveErrorByPull] = useState<
    Record<number, string>
  >({});
  // PR merge (owner-only write). `mergingPull` is mid-request; `confirmMergePull`
  // drives the two-step confirm; `mergeMethod` is the chosen strategy; errors
  // carry GitHub's own message. On success the detail + list are refetched.
  const [mergingPull, setMergingPull] = useState<number | null>(null);
  const [confirmMergePull, setConfirmMergePull] = useState<number | null>(null);
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>("merge");
  const [mergeErrorByPull, setMergeErrorByPull] = useState<
    Record<number, string>
  >({});
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
  // Conversation comments on a commit (GitHub `/commits/{sha}/comments`),
  // fetched alongside the diff and shown at the end of the commit — mirrors the
  // PR conversation. Read-only, same as the PR comment box.
  const [commitCommentsBySha, setCommitCommentsBySha] = useState<
    Record<string, IssueComment[]>
  >({});
  // Per-commit comment composer: the in-progress draft text, the set of SHAs
  // whose comment is currently posting, and any per-commit post error.
  const [commitCommentDraft, setCommitCommentDraft] = useState<
    Record<string, string>
  >({});
  const [postingCommentShas, setPostingCommentShas] = useState<Set<string>>(
    new Set()
  );
  const [commentErrorBySha, setCommentErrorBySha] = useState<
    Record<string, string>
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
  // Which individual file diffs (inside an expanded commit or PR) are
  // collapsed. Files default to expanded, so this Set holds only the
  // ones the user has folded away. Keys are namespaced by their owner
  // (`<sha>::<filename>` for commits, `pr-<n>::<filename>` for PR files)
  // so one Set serves both views without collisions.
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const toggleFile = (key: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
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
  type GitHubPull = {
    number: number;
    title: string;
    html_url: string;
    state: string;
    draft?: boolean;
    // Present (non-null) only on merged PRs — the list endpoint carries it, so
    // we can distinguish Merged from plain Closed without the detail fetch.
    merged_at?: string | null;
    user: { login: string } | null;
    head: { ref: string };
    base: { ref: string };
    created_at: string;
  };
  type Section =
    | "description"
    | "files"
    | "workflows"
    | "commits"
    | "pulls"
    | "actions";
  const [activeSection, setActiveSection] = useState<Section>(() => {
    try {
      const raw = localStorage.getItem("rwayve.github.section");
      if (
        raw === "files" ||
        raw === "workflows" ||
        raw === "commits" ||
        raw === "pulls" ||
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
    async (nextBranch: string, page: number) => {
      setCommitsLoading(true);
      try {
        const data = await githubJson<CommitItem[]>(
          `${API_BASE}/commits?sha=${encodeURIComponent(nextBranch)}` +
            `&per_page=${COMMITS_PER_PAGE}&page=${page}`
        );
        setCommits(data);
        setCommitsPage(page);
        // A full page implies there may be another; a short page is the last.
        setCommitsHasMore(data.length === COMMITS_PER_PAGE);
      } catch {
        setCommits([]);
        setCommitsHasMore(false);
      } finally {
        setCommitsLoading(false);
      }
    },
    [API_BASE]
  );

  // Grand total commits on the branch. GitHub omits a count, but with
  // `per_page=1` the Link header's `rel="last"` page number IS the total. The
  // proxy forwards that header; a missing header means a single page (<=1 commit).
  const loadCommitsTotal = useCallback(
    async (nextBranch: string) => {
      try {
        const token = getAuthToken();
        const res = await fetch(
          `${API_BASE}/commits?sha=${encodeURIComponent(nextBranch)}&per_page=1`,
          {
            credentials: "include",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }
        );
        if (!res.ok) {
          setCommitsTotal(null);
          return;
        }
        const link = res.headers.get("Link");
        const last = link?.match(/[?&]page=(\d+)>;\s*rel="last"/);
        if (last) {
          setCommitsTotal(parseInt(last[1], 10));
          return;
        }
        // No "last" relation → at most one page; the body length is the total.
        const data = (await res.json()) as unknown;
        setCommitsTotal(Array.isArray(data) ? data.length : null);
      } catch {
        setCommitsTotal(null);
      }
    },
    [API_BASE]
  );

  // Open pull requests. PRs aren't branch-filtered, so this takes no branch.
  const loadPulls = useCallback(async () => {
    setPullsError("");
    setPullsLoading(true);
    try {
      const data = await githubJson<GitHubPull[]>(
        `${API_BASE}/pulls?state=all&per_page=50`
      );
      setPulls(data);
    } catch (err) {
      setPulls([]);
      setPullsError(
        err instanceof Error ? err.message : "Pull requests failed to load"
      );
    } finally {
      setPullsLoading(false);
    }
  }, [API_BASE]);

  // Client-side view over the fetched (open + closed/merged) PRs. "closed"
  // includes merged, since a merged PR has state === "closed".
  const filteredPulls = pulls.filter((pr) =>
    pullFilter === "open" ? pr.state === "open" : pr.state !== "open"
  );

  // Fetch one PR's full payload — detail, changed files, conversation
  // (comments + reviews), and CI checks — through the same read-only proxy,
  // then cache it by number. Detail is fetched first because its head.sha
  // drives the check-runs lookup; the rest run in parallel and each degrades
  // to empty on its own error (a missing checks API shouldn't blank the page).
  const loadPullDetail = useCallback(
    async (number: number, force = false) => {
      if (!force && pullBundleByNumber[number]) return;
      setLoadingPullNumbers((current) => new Set(current).add(number));
      setErrorByPullNumber((current) => {
        const next = { ...current };
        delete next[number];
        return next;
      });
      try {
        const detail = await githubJson<PullDetail>(
          `${API_BASE}/pulls/${number}`
        );
        const [files, comments, reviews, checks] = await Promise.all([
          githubJson<CommitFile[]>(
            `${API_BASE}/pulls/${number}/files?per_page=100`
          ).catch(() => [] as CommitFile[]),
          githubJson<IssueComment[]>(
            `${API_BASE}/issues/${number}/comments?per_page=100`
          ).catch(() => [] as IssueComment[]),
          githubJson<PullReview[]>(
            `${API_BASE}/pulls/${number}/reviews?per_page=100`
          ).catch(() => [] as PullReview[]),
          detail.head?.sha
            ? githubJson<CheckRunsResponse>(
                `${API_BASE}/commits/${detail.head.sha}/check-runs`
              )
                .then((r) => r.check_runs ?? [])
                .catch(() => [] as CheckRun[])
            : Promise.resolve([] as CheckRun[]),
        ]);
        setPullBundleByNumber((current) => ({
          ...current,
          [number]: { detail, files, comments, reviews, checks },
        }));
      } catch (err) {
        setErrorByPullNumber((current) => ({
          ...current,
          [number]:
            err instanceof Error
              ? err.message
              : "Could not load this pull request",
        }));
      } finally {
        setLoadingPullNumbers((current) => {
          const next = new Set(current);
          next.delete(number);
          return next;
        });
      }
    },
    [API_BASE, pullBundleByNumber]
  );

  // Open a PR into the detail view and kick off its fetch.
  const openPull = useCallback(
    (number: number) => {
      setSelectedPull(number);
      setDescExpanded(false);
      void loadPullDetail(number);
    },
    [loadPullDetail]
  );

  // Owner approves the PR via the backend proxy. Optimistic on success; on
  // failure surface GitHub's verbatim message (e.g. a 422 "Can not approve your
  // own pull request." or a 403 when the server token lacks write scope).
  const approvePull = async (prNumber: number) => {
    setApprovingPull(prNumber);
    setApproveErrorByPull((cur) => {
      const next = { ...cur };
      delete next[prNumber];
      return next;
    });
    try {
      await approvePullRequest(owner, repoName, prNumber);
      setApprovedPulls((cur) => new Set(cur).add(prNumber));
    } catch (err) {
      setApproveErrorByPull((cur) => ({
        ...cur,
        [prNumber]:
          err instanceof Error
            ? err.message
            : "Couldn't approve this pull request.",
      }));
    } finally {
      setApprovingPull(null);
    }
  };

  // Owner merges the PR via the backend proxy. On success, refetch the detail
  // (flips to merged → the action cards disappear) and the open-PR list (drops
  // it + the count badge). On failure, surface GitHub's verbatim message.
  const mergePull = async (prNumber: number) => {
    setMergingPull(prNumber);
    setConfirmMergePull(null);
    setMergeErrorByPull((cur) => {
      const next = { ...cur };
      delete next[prNumber];
      return next;
    });
    try {
      await mergePullRequest(owner, repoName, prNumber, mergeMethod);
      await loadPullDetail(prNumber, true);
      await loadPulls();
    } catch (err) {
      setMergeErrorByPull((cur) => ({
        ...cur,
        [prNumber]:
          err instanceof Error
            ? err.message
            : "Couldn't merge this pull request.",
      }));
    } finally {
      setMergingPull(null);
    }
  };

  // Raw unified diff for a PR via the proxy's `?media=diff` opt-in — the
  // fallback when GitHub omits per-file patches (large files). Cached by
  // number. Mirrors loadFullDiff for commits.
  const loadPullFullDiff = useCallback(
    async (number: number) => {
      if (pullFullDiff[number]) return;
      setPullFullDiffLoading((current) => new Set(current).add(number));
      setPullFullDiffError((current) => {
        const next = { ...current };
        delete next[number];
        return next;
      });
      try {
        const token = getAuthToken();
        const response = await fetch(`${API_BASE}/pulls/${number}?media=diff`, {
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!response.ok) {
          throw new Error(`GitHub diff failed (${response.status})`);
        }
        const text = await response.text();
        const capped =
          text.length > 2_000_000
            ? `${text.slice(0, 2_000_000)}\n\n…diff truncated; open on GitHub for the full patch`
            : text;
        setPullFullDiff((current) => ({ ...current, [number]: capped }));
      } catch (err) {
        setPullFullDiffError((current) => ({
          ...current,
          [number]:
            err instanceof Error ? err.message : "Could not load full diff",
        }));
      } finally {
        setPullFullDiffLoading((current) => {
          const next = new Set(current);
          next.delete(number);
          return next;
        });
      }
    },
    [API_BASE, pullFullDiff]
  );

  // Fetch the per-commit detail (which includes the patch for every changed
  // file) via the same /api/github proxy the rest of this page uses, and cache
  // it by SHA. Skips the network when already cached unless `force` is set
  // (used by the Retry affordance after a failed/empty load).
  const loadCommitDetail = useCallback(
    async (sha: string, force = false) => {
      if (!force && commitDetailBySha[sha]) return;

      setLoadingCommitShas((current) => new Set(current).add(sha));
      setErrorByCommitSha((current) => {
        const next = { ...current };
        delete next[sha];
        return next;
      });
      try {
        const [data, comments] = await Promise.all([
          githubJson<CommitDetail>(
            `${API_BASE}/commits/${encodeURIComponent(sha)}`
          ),
          githubJson<IssueComment[]>(
            `${API_BASE}/commits/${encodeURIComponent(sha)}/comments?per_page=100`
          ).catch(() => [] as IssueComment[]),
        ]);
        setCommitDetailBySha((current) => ({ ...current, [sha]: data }));
        setCommitCommentsBySha((current) => ({ ...current, [sha]: comments }));
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

  // Expand a commit row inline to show its file-level diff. First open kicks
  // off the per-commit detail fetch; subsequent toggles read from the
  // in-component cache so re-opening is instant.
  const toggleCommitDetail = useCallback(
    (sha: string) => {
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
      if (opened) void loadCommitDetail(sha);
    },
    [loadCommitDetail]
  );

  // Self-heal: any commit that is expanded but has no detail, no error, and
  // isn't already loading gets its diff fetched automatically. Covers cases
  // where a row is open without going through the click path — the commit list
  // reloaded (clearing the detail cache), state reset, or a token/access fix —
  // so the diff loads on its own instead of stranding the user on the manual
  // "Refresh" fallback.
  useEffect(() => {
    for (const sha of expandedCommitShas) {
      if (
        !commitDetailBySha[sha] &&
        !errorByCommitSha[sha] &&
        !loadingCommitShas.has(sha)
      ) {
        void loadCommitDetail(sha);
      }
    }
  }, [
    expandedCommitShas,
    commitDetailBySha,
    errorByCommitSha,
    loadingCommitShas,
    loadCommitDetail,
  ]);

  // Post a comment on a commit. On success the created comment (returned by the
  // proxy) is appended locally — avoids the 60s GET cache serving a stale list.
  const submitCommitComment = useCallback(
    async (sha: string) => {
      const body = (commitCommentDraft[sha] ?? "").trim();
      if (!body || postingCommentShas.has(sha)) return;
      setPostingCommentShas((cur) => new Set(cur).add(sha));
      setCommentErrorBySha((cur) => {
        const next = { ...cur };
        delete next[sha];
        return next;
      });
      try {
        const created = await createCommitComment(owner, repoName, sha, body);
        setCommitCommentsBySha((cur) => ({
          ...cur,
          [sha]: [...(cur[sha] ?? []), created],
        }));
        setCommitCommentDraft((cur) => ({ ...cur, [sha]: "" }));
      } catch (err) {
        setCommentErrorBySha((cur) => ({
          ...cur,
          [sha]:
            err instanceof Error ? err.message : "Couldn't post the comment.",
        }));
      } finally {
        setPostingCommentShas((cur) => {
          const next = new Set(cur);
          next.delete(sha);
          return next;
        });
      }
    },
    [commitCommentDraft, postingCommentShas, owner, repoName]
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
      // Decide open/close from the CURRENT state synchronously. Do NOT read a
      // flag mutated inside the setState updater — React may run that updater
      // asynchronously, so the flag was still false here and the jobs fetch
      // below was silently skipped (the run rendered "no jobs to display").
      const willOpen = !expandedRunIds.has(run.id);
      setExpandedRunIds((current) => {
        const next = new Set(current);
        if (next.has(run.id)) {
          next.delete(run.id);
        } else {
          next.add(run.id);
        }
        return next;
      });
      if (!willOpen) return;
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
    [API_BASE, jobsByRunId, expandedRunIds]
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
    void loadCommits(branch, 1);
    void loadCommitsTotal(branch);
    // Reopening the PR list (vs. a stale detail) whenever the repo/branch
    // changes keeps the tab coherent across repo switches. PRs are owner-only,
    // so non-owners never fetch them (the proxy would 403 anyway).
    setSelectedPull(null);
    if (isOwner) void loadPulls();
    // Actions list is now branch-agnostic (a push to any branch should
    // surface), so we only refresh it on the initial repo load and
    // reset per-run UI state at the same time. Run-detail caches stay
    // valid (keyed by run id, which is global).
    setRunsPage(1);
    setRunsTotal(0);
    setExpandedRunIds(new Set());
    setExpandedJobIds(new Set());
    void loadRuns(1, false);
  }, [
    branch,
    isOwner,
    loadCommits,
    loadCommitsTotal,
    loadPulls,
    loadReadme,
    loadRuns,
    loadWorkflows,
    repo,
  ]);

  // A non-owner can land on "pulls" if it was persisted from a prior owner
  // session or the role changed mid-session. PRs are owner-only, so fall back
  // to the overview instead of showing a blank panel.
  useEffect(() => {
    if (!isOwner && activeSection === "pulls") setActiveSection("description");
  }, [isOwner, activeSection]);

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
              <span className="github-sidebar-count">
                {commitsTotal ?? commits.length}
              </span>
            </button>
            {isOwner && (
              <button
                type="button"
                className={`github-sidebar-link ${activeSection === "pulls" ? "active" : ""}`}
                onClick={() => setActiveSection("pulls")}
              >
                <span className="github-sidebar-icon" aria-hidden="true">
                  🔀
                </span>
                <span className="github-sidebar-label">Pull Requests</span>
                <span className="github-sidebar-count">{pulls.length}</span>
              </button>
            )}
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
                <span>{commitsTotal ?? commits.length}</span>
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
                        {!isLoading && !errorText && !detail && (
                          <div className="github-empty">
                            Couldn't load this commit's changes.{" "}
                            <button
                              type="button"
                              className="github-link-btn"
                              onClick={() =>
                                void loadCommitDetail(commit.sha, true)
                              }
                            >
                              Refresh
                            </button>
                          </div>
                        )}
                        {!isLoading && !errorText && detail && (
                          <>
                            {(detail.files ?? []).map((file) => {
                              const fileKey = `${commit.sha}::${file.filename}`;
                              const fileOpen = !collapsedFiles.has(fileKey);
                              return (
                                <article
                                  key={file.filename}
                                  className={`github-commit-file status-${file.status} ${fileOpen ? "is-open" : "is-collapsed"}`}
                                >
                                  <button
                                    type="button"
                                    className="github-commit-file-head"
                                    onClick={() => toggleFile(fileKey)}
                                    aria-expanded={fileOpen}
                                  >
                                    <span
                                      className={`github-tree-toggle ${fileOpen ? "open" : ""}`}
                                      aria-hidden="true"
                                    >
                                      <ChevronIcon />
                                    </span>
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
                                  </button>
                                  {fileOpen &&
                                    (file.patch ? (
                                      <CommitSplitPatch patch={file.patch} />
                                    ) : (
                                      <div className="github-commit-nopatch">
                                        Binary file or diff not available — open
                                        on GitHub to view.
                                      </div>
                                    ))}
                                </article>
                              );
                            })}
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

                            {/* Conversation comments on this commit
                                (read-only, mirrors the PR comment thread). */}
                            {(() => {
                              const comments =
                                commitCommentsBySha[commit.sha] ?? [];
                              return (
                                <div className="github-commit-comments">
                                  <div className="github-commit-comments-head">
                                    <h4>Comments</h4>
                                    <span className="github-pr-block-count">
                                      {comments.length}
                                    </span>
                                  </div>
                                  {comments.length === 0 ? (
                                    <div className="github-empty">
                                      No comments on this commit yet.
                                    </div>
                                  ) : (
                                    <ul className="github-pr-thread">
                                      {comments.map((c) => (
                                        <li
                                          key={c.id}
                                          className="github-pr-comment"
                                        >
                                          <PrAvatar
                                            name={c.user?.login ?? "ghost"}
                                          />
                                          <div className="github-pr-comment-main">
                                            <div className="github-pr-comment-head">
                                              <strong>
                                                {c.user?.login ?? "unknown"}
                                              </strong>
                                              {c.created_at && (
                                                <small className="github-pr-comment-time">
                                                  {formatDate(c.created_at)}
                                                </small>
                                              )}
                                            </div>
                                            {c.body?.trim() && (
                                              <div className="github-pr-comment-text">
                                                {renderRichText(c.body)}
                                              </div>
                                            )}
                                          </div>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                  <div className="github-commit-composer">
                                    <textarea
                                      className="github-commit-composer-input"
                                      placeholder="Leave a comment on this commit…"
                                      value={
                                        commitCommentDraft[commit.sha] ?? ""
                                      }
                                      onChange={(e) =>
                                        setCommitCommentDraft((cur) => ({
                                          ...cur,
                                          [commit.sha]: e.target.value,
                                        }))
                                      }
                                      rows={3}
                                      disabled={postingCommentShas.has(
                                        commit.sha
                                      )}
                                    />
                                    {commentErrorBySha[commit.sha] && (
                                      <div className="github-banner">
                                        {commentErrorBySha[commit.sha]}
                                      </div>
                                    )}
                                    <div className="github-commit-composer-foot">
                                      <span className="github-commit-composer-note">
                                        Posts to GitHub as the connected account.
                                      </span>
                                      <button
                                        type="button"
                                        className="github-commit-composer-send"
                                        disabled={
                                          postingCommentShas.has(commit.sha) ||
                                          !(
                                            commitCommentDraft[commit.sha] ?? ""
                                          ).trim()
                                        }
                                        onClick={() =>
                                          void submitCommitComment(commit.sha)
                                        }
                                      >
                                        {postingCommentShas.has(commit.sha)
                                          ? "Posting…"
                                          : "Comment"}
                                      </button>
                                    </div>
                                  </div>
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
                <div className="github-empty">
                  {commitsLoading
                    ? "Loading commits…"
                    : commitsPage > 1
                      ? "No more commits."
                      : "No commits found."}
                </div>
              )}

              {(commitsHasMore || commitsPage > 1) && (
                <div className="github-pager">
                  <button
                    type="button"
                    disabled={commitsPage <= 1 || commitsLoading}
                    onClick={() => void loadCommits(branch, commitsPage - 1)}
                  >
                    ← Previous
                  </button>
                  <span className="github-pager-label">
                    Page {commitsPage}
                  </span>
                  <button
                    type="button"
                    disabled={!commitsHasMore || commitsLoading}
                    onClick={() => void loadCommits(branch, commitsPage + 1)}
                  >
                    Next →
                  </button>
                </div>
              )}
            </div>
          )}

          {isOwner &&
            activeSection === "pulls" &&
            (selectedPull == null ? (
              <div className="github-panel">
                <div className="github-panel-head">
                  <h2>Pull Requests</h2>
                  <span>{filteredPulls.length}</span>
                </div>
                <div className="github-pr-filter">
                  {(["open", "closed"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={`github-pr-filter-btn ${pullFilter === f ? "active" : ""}`}
                      onClick={() => setPullFilter(f)}
                    >
                      {f === "open" ? "Open" : "Closed"}
                    </button>
                  ))}
                </div>
                {pullsLoading ? (
                  <div className="github-empty">Loading pull requests…</div>
                ) : pullsError ? (
                  <div className="github-empty">{pullsError}</div>
                ) : filteredPulls.length === 0 ? (
                  <div className="github-empty">
                    {`No ${pullFilter} pull requests.`}
                  </div>
                ) : (
                  filteredPulls.map((pr) => {
                    const status = pullStatus({
                      state: pr.state,
                      draft: pr.draft,
                      merged: !!pr.merged_at,
                    });
                    return (
                      <div key={pr.number} className="github-pr-node">
                        <button
                          type="button"
                          className="github-pr-main github-pr-open-btn"
                          onClick={() => openPull(pr.number)}
                        >
                          <strong className="github-pr-title">
                            {pr.title}
                          </strong>
                          <small className="github-pr-meta">
                            #{pr.number} · {pr.user?.login ?? "unknown"} ·{" "}
                            {pr.head.ref} → {pr.base.ref} ·{" "}
                            {formatDate(pr.created_at)}
                          </small>
                        </button>
                        <span className={`github-pr-status ${status.cls}`}>
                          {status.label}
                        </span>
                        <a
                          className="github-pr-link"
                          href={pr.html_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open on GitHub →
                        </a>
                      </div>
                    );
                  })
                )}
              </div>
            ) : (
              <div className="github-panel">
                <div className="github-pr-detail-head">
                  <button
                    type="button"
                    className="github-link-btn"
                    onClick={() => setSelectedPull(null)}
                  >
                    ← Back to pull requests
                  </button>
                </div>
                {loadingPullNumbers.has(selectedPull) ? (
                  <div className="github-empty">Loading pull request…</div>
                ) : errorByPullNumber[selectedPull] ? (
                  <div className="github-banner">
                    {errorByPullNumber[selectedPull]}
                  </div>
                ) : !pullBundleByNumber[selectedPull] ? (
                  <div className="github-empty">
                    Couldn't load this pull request.{" "}
                    <button
                      type="button"
                      className="github-link-btn"
                      onClick={() => void loadPullDetail(selectedPull, true)}
                    >
                      Refresh
                    </button>
                  </div>
                ) : (
                  (() => {
                    const bundle = pullBundleByNumber[selectedPull];
                    const d = bundle.detail;
                    const status = pullStatus(d);
                    const passed = bundle.checks.filter(
                      (c) => c.conclusion === "success"
                    ).length;
                    // Comments + meaningful reviews, oldest first. A bare
                    // COMMENTED review with no body is GitHub's wrapper around
                    // inline code comments — drop it so the thread stays clean.
                    const timeline: TimelineEntry[] = [
                      ...bundle.comments.map((c) => ({
                        key: `c${c.id}`,
                        author: c.user?.login ?? "unknown",
                        body: c.body ?? "",
                        ts: c.created_at,
                      })),
                      ...bundle.reviews
                        .filter(
                          (r) =>
                            Boolean(r.body?.trim()) ||
                            r.state === "APPROVED" ||
                            r.state === "CHANGES_REQUESTED" ||
                            r.state === "DISMISSED"
                        )
                        .map((r) => ({
                          key: `r${r.id}`,
                          author: r.user?.login ?? "unknown",
                          body: r.body ?? "",
                          ts: r.submitted_at ?? "",
                          reviewState: r.state,
                        })),
                    ].sort(
                      (a, b) => Date.parse(a.ts || "") - Date.parse(b.ts || "")
                    );
                    const hasMissingPatch = bundle.files.some(
                      (f) =>
                        !f.patch &&
                        f.status !== "added" &&
                        f.status !== "removed"
                    );
                    const rawDiff = pullFullDiff[selectedPull];
                    const repoLabel = `${owner}/${repoName}`;
                    const bodyText = d.body ?? "";
                    const bodyLong = bodyText.length > 280;
                    let descShown = bodyText;
                    if (!descExpanded && bodyLong) {
                      const firstPara = bodyText.split("\n\n")[0];
                      descShown =
                        firstPara.length <= 280
                          ? firstPara
                          : `${firstPara.slice(0, 280).trimEnd()}…`;
                    }
                    const isCollapsed = (k: string) =>
                      collapsedPrSections.has(k);
                    const toggleSection = (k: string) =>
                      setCollapsedPrSections((cur) => {
                        const next = new Set(cur);
                        if (next.has(k)) next.delete(k);
                        else next.add(k);
                        return next;
                      });
                    return (
                      <div className="github-pr-detail">
                        <div className="github-pr-grid">
                          <div className="github-pr-main-col">
                            <h2 className="github-pr-detail-h">{d.title}</h2>
                            <div className="github-pr-pillrow">
                              <span
                                className={`github-pr-status ${status.cls}`}
                              >
                                {status.label}
                              </span>
                              <a
                                className="github-pr-repochip"
                                href={d.html_url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {repoLabel}#{d.number}
                              </a>
                              {(d.additions != null ||
                                d.deletions != null) && (
                                <span className="github-pr-changechip">
                                  <span className="is-add">
                                    +{d.additions ?? 0}
                                  </span>{" "}
                                  <span className="is-del">
                                    −{d.deletions ?? 0}
                                  </span>
                                </span>
                              )}
                            </div>

                            {bodyText.trim() && (
                              <div className="github-pr-desc">
                                {renderRichText(descShown)}
                                {bodyLong && (
                                  <button
                                    type="button"
                                    className="github-pr-showmore"
                                    onClick={() => setDescExpanded((v) => !v)}
                                  >
                                    {descExpanded ? "Show less" : "Show more"}
                                  </button>
                                )}
                              </div>
                            )}

                            <section className="github-pr-block">
                              <button
                                type="button"
                                className="github-pr-block-head"
                                onClick={() => toggleSection("discussion")}
                                aria-expanded={!isCollapsed("discussion")}
                              >
                                <span
                                  className={`github-pr-chevron ${isCollapsed("discussion") ? "" : "open"}`}
                                >
                                  <ChevronIcon />
                                </span>
                                <h3>Discussion</h3>
                                {timeline.length > 0 && (
                                  <span className="github-pr-block-count">
                                    {timeline.length}
                                  </span>
                                )}
                              </button>
                              {!isCollapsed("discussion") && (
                                <div className="github-pr-block-body">
                                  {timeline.length === 0 ? (
                                    <div className="github-empty">
                                      No conversation yet.
                                    </div>
                                  ) : (
                                    <ul className="github-pr-thread">
                                      {timeline.map((e) => (
                                        <li
                                          key={e.key}
                                          className="github-pr-comment"
                                        >
                                          <PrAvatar name={e.author} />
                                          <div className="github-pr-comment-main">
                                            <div className="github-pr-comment-head">
                                              <strong>{e.author}</strong>
                                              {e.reviewState && (
                                                <span
                                                  className={`github-pr-review-badge ${reviewBadge(e.reviewState).cls}`}
                                                >
                                                  {
                                                    reviewBadge(e.reviewState)
                                                      .label
                                                  }
                                                </span>
                                              )}
                                              {e.ts && (
                                                <small className="github-pr-comment-time">
                                                  {formatDate(e.ts)}
                                                </small>
                                              )}
                                            </div>
                                            {e.body.trim() && (
                                              <div className="github-pr-comment-text">
                                                {renderRichText(e.body)}
                                              </div>
                                            )}
                                          </div>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                  <div
                                    className="github-pr-composer"
                                    aria-disabled="true"
                                    title="Read-only — commenting needs a connected GitHub account"
                                  >
                                    <div className="github-pr-composer-input">
                                      Leave a comment…
                                    </div>
                                    <div className="github-pr-composer-foot">
                                      <span className="github-pr-composer-tools">
                                        <span aria-hidden="true">📎</span>
                                        <span aria-hidden="true">Aa</span>
                                      </span>
                                      <span
                                        className="github-pr-composer-send"
                                        aria-hidden="true"
                                      >
                                        ↑
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </section>

                            <section className="github-pr-block">
                              <button
                                type="button"
                                className="github-pr-block-head"
                                onClick={() => toggleSection("files")}
                                aria-expanded={!isCollapsed("files")}
                              >
                                <span
                                  className={`github-pr-chevron ${isCollapsed("files") ? "" : "open"}`}
                                >
                                  <ChevronIcon />
                                </span>
                                <h3>Files changed</h3>
                                {bundle.files.length > 0 && (
                                  <span className="github-pr-block-count">
                                    {bundle.files.length}
                                  </span>
                                )}
                              </button>
                              {!isCollapsed("files") && (
                                <div className="github-pr-block-body">
                                  {bundle.files.length === 0 ? (
                                    <div className="github-empty">
                                      No file changes to show.
                                    </div>
                                  ) : (
                                    bundle.files.map((file) => {
                                      const fileKey = `pr-${selectedPull}::${file.filename}`;
                                      const fileOpen =
                                        !collapsedFiles.has(fileKey);
                                      return (
                                        <article
                                          key={file.filename}
                                          className={`github-commit-file status-${file.status} ${fileOpen ? "is-open" : "is-collapsed"}`}
                                        >
                                          <button
                                            type="button"
                                            className="github-commit-file-head"
                                            onClick={() => toggleFile(fileKey)}
                                            aria-expanded={fileOpen}
                                          >
                                            <span
                                              className={`github-tree-toggle ${fileOpen ? "open" : ""}`}
                                              aria-hidden="true"
                                            >
                                              <ChevronIcon />
                                            </span>
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
                                          </button>
                                          {fileOpen &&
                                            (file.patch ? (
                                              <CommitSplitPatch
                                                patch={file.patch}
                                              />
                                            ) : (
                                              <div className="github-commit-nopatch">
                                                Binary file or diff not
                                                available — open on GitHub to
                                                view.
                                              </div>
                                            ))}
                                        </article>
                                      );
                                    })
                                  )}
                                  {(hasMissingPatch || rawDiff) && (
                                    <div className="github-commit-fulldiff">
                                      {!rawDiff && (
                                        <button
                                          type="button"
                                          className="github-commit-fulldiff-btn"
                                          onClick={() =>
                                            void loadPullFullDiff(selectedPull)
                                          }
                                          disabled={pullFullDiffLoading.has(
                                            selectedPull
                                          )}
                                        >
                                          {pullFullDiffLoading.has(selectedPull)
                                            ? "Loading full diff…"
                                            : "Load full diff"}
                                        </button>
                                      )}
                                      {pullFullDiffError[selectedPull] && (
                                        <div className="github-banner">
                                          {pullFullDiffError[selectedPull]}
                                        </div>
                                      )}
                                      {rawDiff && (
                                        <RawUnifiedDiff text={rawDiff} />
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </section>
                          </div>

                          <aside className="github-pr-side-col">
                            {d.state === "open" && !d.merged && (
                              <div className="github-pr-card github-pr-approve-card">
                                <span className="github-pr-card-title">
                                  Owner review
                                </span>
                                {approvedPulls.has(selectedPull) ||
                                bundle.reviews.some(
                                  (r) => r.state === "APPROVED"
                                ) ? (
                                  <div className="github-pr-approved">
                                    ✓ Approved
                                  </div>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      className="github-pr-approve-btn"
                                      onClick={() =>
                                        void approvePull(selectedPull)
                                      }
                                      disabled={approvingPull === selectedPull}
                                    >
                                      {approvingPull === selectedPull
                                        ? "Approving…"
                                        : "Approve pull request"}
                                    </button>
                                    {approveErrorByPull[selectedPull] && (
                                      <div className="github-pr-approve-err">
                                        {approveErrorByPull[selectedPull]}
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                            {d.state === "open" && !d.merged && (
                              <div className="github-pr-card github-pr-merge-card">
                                <span className="github-pr-card-title">
                                  Merge
                                </span>
                                {d.mergeable === false ? (
                                  <div className="github-pr-merge-err">
                                    This branch has conflicts that must be
                                    resolved before it can be merged.
                                  </div>
                                ) : confirmMergePull === selectedPull ? (
                                  <>
                                    <div className="github-pr-merge-confirmtext">
                                      Merge #{selectedPull} into{" "}
                                      <code>{d.base.ref}</code>?
                                    </div>
                                    <div className="github-pr-merge-actions">
                                      <button
                                        type="button"
                                        className="github-pr-merge-confirm"
                                        onClick={() =>
                                          void mergePull(selectedPull)
                                        }
                                        disabled={mergingPull === selectedPull}
                                      >
                                        {mergingPull === selectedPull
                                          ? "Merging…"
                                          : "Confirm merge"}
                                      </button>
                                      <button
                                        type="button"
                                        className="github-pr-merge-cancel"
                                        onClick={() => setConfirmMergePull(null)}
                                        disabled={mergingPull === selectedPull}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <select
                                      className="github-pr-merge-method"
                                      value={mergeMethod}
                                      onChange={(e) =>
                                        setMergeMethod(
                                          e.target.value as MergeMethod
                                        )
                                      }
                                    >
                                      <option value="merge">
                                        Create a merge commit
                                      </option>
                                      <option value="squash">
                                        Squash and merge
                                      </option>
                                      <option value="rebase">
                                        Rebase and merge
                                      </option>
                                    </select>
                                    <button
                                      type="button"
                                      className="github-pr-merge-btn"
                                      onClick={() =>
                                        setConfirmMergePull(selectedPull)
                                      }
                                    >
                                      Merge pull request
                                    </button>
                                  </>
                                )}
                                {mergeErrorByPull[selectedPull] && (
                                  <div className="github-pr-merge-err">
                                    {mergeErrorByPull[selectedPull]}
                                  </div>
                                )}
                              </div>
                            )}
                            <div className="github-pr-card">
                              <button
                                type="button"
                                className="github-pr-card-head"
                                onClick={() => toggleSection("details")}
                                aria-expanded={!isCollapsed("details")}
                              >
                                <span
                                  className={`github-pr-chevron ${isCollapsed("details") ? "" : "open"}`}
                                >
                                  <ChevronIcon />
                                </span>
                                <span className="github-pr-card-title">
                                  Details
                                </span>
                              </button>
                              {!isCollapsed("details") && (
                                <dl className="github-pr-details">
                                  <div className="github-pr-detail-row">
                                    <dt>Author</dt>
                                    <dd className="github-pr-author">
                                      <PrAvatar
                                        name={d.user?.login ?? "unknown"}
                                      />
                                      {d.user?.login ?? "unknown"}
                                    </dd>
                                  </div>
                                  <div className="github-pr-detail-row">
                                    <dt>Repository</dt>
                                    <dd>{repoLabel}</dd>
                                  </div>
                                  <div className="github-pr-detail-row">
                                    <dt>Status</dt>
                                    <dd>
                                      <span
                                        className={`github-pr-status ${status.cls}`}
                                      >
                                        {status.label}
                                      </span>
                                    </dd>
                                  </div>
                                  <div className="github-pr-detail-row">
                                    <dt>Changes</dt>
                                    <dd>
                                      <span className="github-commit-stat is-add">
                                        +{d.additions ?? 0}
                                      </span>{" "}
                                      <span className="github-commit-stat is-del">
                                        −{d.deletions ?? 0}
                                      </span>
                                    </dd>
                                  </div>
                                  <div className="github-pr-detail-row">
                                    <dt>GitHub</dt>
                                    <dd>
                                      <a
                                        className="github-pr-link"
                                        href={d.html_url}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        {repoLabel}#{d.number}
                                      </a>
                                    </dd>
                                  </div>
                                </dl>
                              )}
                            </div>

                            <div className="github-pr-card">
                              <button
                                type="button"
                                className="github-pr-card-head"
                                onClick={() => toggleSection("checks")}
                                aria-expanded={!isCollapsed("checks")}
                              >
                                <span
                                  className={`github-pr-chevron ${isCollapsed("checks") ? "" : "open"}`}
                                >
                                  <ChevronIcon />
                                </span>
                                <span className="github-pr-card-title">
                                  Checks
                                </span>
                                {bundle.checks.length > 0 && (
                                  <span className="github-pr-checks-sum">
                                    ✓ {passed} passed
                                  </span>
                                )}
                              </button>
                              {!isCollapsed("checks") && (
                                <div className="github-pr-card-body">
                                  {bundle.checks.length === 0 ? (
                                    <div className="github-empty">
                                      No checks reported.
                                    </div>
                                  ) : (
                                    <ul className="github-pr-checks">
                                      {bundle.checks.map((c) => {
                                        const ck = checkVisual(c);
                                        return (
                                          <li
                                            key={c.id}
                                            className={`github-pr-check ${ck.cls}`}
                                          >
                                            <span className="github-pr-check-icon">
                                              {ck.icon}
                                            </span>
                                            <span className="github-pr-check-name">
                                              {c.name}
                                            </span>
                                            <span className="github-pr-check-dur">
                                              {formatDuration(
                                                c.started_at ?? null,
                                                c.completed_at ?? null
                                              )}
                                            </span>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  )}
                                </div>
                              )}
                            </div>
                          </aside>
                        </div>
                      </div>
                    );
                  })()
                )}
              </div>
            ))}

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
  const [importing, setImporting] = useState(false);
  const [importCount, setImportCount] = useState(0);
  // GitHub connection: null = loading, then { connected, login? }.
  const [ghConn, setGhConn] = useState<{
    connected: boolean;
    login?: string;
  } | null>(null);

  const refreshConnection = useCallback(() => {
    void getGithubConnection()
      .then(setGhConn)
      .catch(() => setGhConn({ connected: false }));
  }, []);

  // Load connection on mount, and re-check after returning from the OAuth
  // redirect (the callback bounces back to /github#connected=true).
  useEffect(() => {
    refreshConnection();
    if (window.location.hash.includes("connected=true")) {
      history.replaceState(null, "", window.location.pathname);
      refreshConnection();
    }
  }, [refreshConnection]);

  const connectGithub = () => {
    setErr("");
    void getGithubConnectUrl()
      .then((u) => {
        window.location.href = u;
      })
      .catch((e) =>
        setErr(
          e instanceof Error ? e.message : "Couldn't start the GitHub connect flow."
        )
      );
  };

  const disconnect = () => {
    void disconnectGithub()
      .then(() => setGhConn({ connected: false }))
      .catch(() => {});
  };

  // Pull every repo the user's connected GitHub can access and add them all in
  // one click, instead of pasting URLs one at a time.
  const importAll = () => {
    if (busy || importing) return;
    setImporting(true);
    setImportCount(0);
    setErr("");
    void importAllRepos(projects ?? [], setImportCount)
      .then((created) => {
        if (created.length === 0) {
          setErr("No new repositories to import.");
          return;
        }
        setProjects((prev) => [...created, ...(prev ?? [])]);
        setSelectedId(created[0].id);
        setAdding(false);
      })
      .catch((e) =>
        setErr(
          e instanceof Error
            ? e.message
            : "Couldn't reach GitHub — check the connection."
        )
      )
      .finally(() => setImporting(false));
  };

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

      {/* GitHub account controls — reachable here too (not just the empty
          state) so a user with repos can still import more / disconnect. */}
      <div className="github-repo-switch-conn">
        {ghConn?.connected ? (
          <>
            <button
              type="button"
              className="github-link-btn"
              onClick={importAll}
              disabled={busy || importing}
            >
              {importing
                ? `Importing… (${importCount})`
                : "Import all my repositories"}
            </button>
            <span className="github-repo-switch-conn-who">
              @{ghConn.login}
              {" · "}
              <button
                type="button"
                className="github-link-btn"
                onClick={disconnect}
              >
                Disconnect
              </button>
            </span>
          </>
        ) : (
          <button
            type="button"
            className="github-link-btn"
            onClick={connectGithub}
            disabled={ghConn === null}
          >
            Connect GitHub
          </button>
        )}
      </div>
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
              disabled={busy || importing}
              autoFocus
            />
            <button
              type="button"
              className="github-add-repo-btn"
              onClick={submitAdd}
              disabled={busy || importing || !url.trim()}
            >
              {busy ? "Adding…" : "Add repository"}
            </button>
          </div>
          <div className="github-add-repo-alt">
            <span className="github-add-repo-or">or</span>
            {ghConn?.connected ? (
              <button
                type="button"
                className="github-add-repo-import-btn"
                onClick={importAll}
                disabled={busy || importing}
              >
                {importing
                  ? `Importing your repositories… (${importCount})`
                  : "Import all my repositories"}
              </button>
            ) : (
              <button
                type="button"
                className="github-add-repo-import-btn"
                onClick={connectGithub}
                disabled={busy || ghConn === null}
              >
                Connect GitHub to import your repos
              </button>
            )}
          </div>
          {ghConn?.connected && (
            <p className="github-add-repo-conn">
              Connected as @{ghConn.login}
              {" · "}
              <button
                type="button"
                className="github-link-btn"
                onClick={disconnect}
              >
                Disconnect
              </button>
            </p>
          )}
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
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [importing, setImporting] = useState(false);
  const [importCount, setImportCount] = useState(0);

  // Import every repo the connected GitHub token can access as its own org
  // project in one click (owner-only, same gate as the paste-URL form).
  const importAll = () => {
    if (busy || importing) return;
    setImporting(true);
    setImportCount(0);
    setErr("");
    void importAllRepos(projects ?? [], setImportCount)
      .then((created) => {
        if (created.length === 0) {
          setErr("No new repositories to import.");
          return;
        }
        setProjects((prev) => [...created, ...(prev ?? [])]);
        setSelectedId(created[0].id);
        setAdding(false);
      })
      .catch((e) =>
        setErr(
          e instanceof Error
            ? e.message
            : "Couldn't reach GitHub — check the connection."
        )
      )
      .finally(() => setImporting(false));
  };

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

  // Owners import a repo in one step: create an org project named after the
  // repo and link it together. Mirrors PersonalRepoManager.submitAdd — org
  // create now honors repo_url server-side, and the endpoint stays owner-gated.
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

  if (projects === null) {
    return (
      <div className="github-page github-empty-state">
        <p className="github-empty">Loading projects…</p>
      </div>
    );
  }
  if (projects.length === 0) {
    // Owners get the one-step import form; everyone else a read-only hint.
    if (!canLink) {
      return (
        <div className="github-page github-empty-state">
          <div className="github-add-repo">
            <h2 className="github-add-repo-title">No projects yet</h2>
            <p className="github-add-repo-help">
              An organization owner can create a project and link a repository
              from the sidebar.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="github-page github-empty-state">
        <div className="github-add-repo">
          <h2 className="github-add-repo-title">Add a repository</h2>
          <p className="github-add-repo-help">
            Paste a public GitHub repository URL to create a project and browse
            its code, commits and Actions here.
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
              disabled={busy || importing}
              autoFocus
            />
            <button
              type="button"
              className="github-add-repo-btn"
              onClick={submitAdd}
              disabled={busy || importing || !url.trim()}
            >
              {busy ? "Adding…" : "Add repository"}
            </button>
          </div>
          <div className="github-add-repo-alt">
            <span className="github-add-repo-or">or</span>
            <button
              type="button"
              className="github-add-repo-import-btn"
              onClick={importAll}
              disabled={busy || importing}
            >
              {importing
                ? `Importing all repositories… (${importCount})`
                : "Import all repositories"}
            </button>
          </div>
          {err && <p className="github-add-repo-error">{err}</p>}
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
      {canLink && (
        <>
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
        </>
      )}
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
