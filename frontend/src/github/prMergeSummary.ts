// Pure tallies behind the PR merge box (PrMergeBox): GitHub's Checks /
// Comments / Approvals summary, computed from the REST data the PR page loads.

/** One GitHub check run (`GET /repos/{o}/{r}/commits/{sha}/check-runs`). */
export type CheckRun = {
  id: number;
  name: string;
  /** queued | in_progress | completed | waiting | requested | pending */
  status: string;
  /** Set once completed: success | failure | neutral | cancelled | skipped |
   *  timed_out | action_required | stale | startup_failure */
  conclusion: string | null;
  html_url?: string | null;
};

export type CheckSummary = {
  total: number;
  passed: number;
  failing: number;
  pending: number;
  skipped: number;
};

const PASSED = new Set(["success", "neutral"]);
const SKIPPED = new Set(["skipped", "stale"]);

export function summarizeChecks(runs: CheckRun[]): CheckSummary {
  const s = {
    total: runs.length,
    passed: 0,
    failing: 0,
    pending: 0,
    skipped: 0,
  };
  for (const run of runs) {
    if (run.status !== "completed" || !run.conclusion) s.pending += 1;
    else if (PASSED.has(run.conclusion)) s.passed += 1;
    else if (SKIPPED.has(run.conclusion)) s.skipped += 1;
    else s.failing += 1;
  }
  return s;
}

/** "6 failing", "2 pending", "All passed", "No checks" — the Checks label. */
export function checksLabel(s: CheckSummary): string {
  if (s.total === 0) return "No checks";
  if (s.failing > 0) return `${s.failing} failing`;
  if (s.pending > 0) return `${s.pending} pending`;
  return s.skipped > 0
    ? `${s.passed} passed, ${s.skipped} skipped`
    : "All passed";
}

type Review = {
  user: { login: string } | null;
  state: string;
  submitted_at: string | null;
};

export type ApprovalSummary = {
  approved: string[];
  changesRequested: string[];
};

/** Each reviewer's latest verdict, as GitHub counts it: a later APPROVED or
 *  CHANGES_REQUESTED replaces an earlier one, DISMISSED clears it, and plain
 *  COMMENTED reviews don't change it. */
export function summarizeApprovals(reviews: Review[]): ApprovalSummary {
  const latest = new Map<string, string>();
  const ordered = [...reviews].sort(
    (a, b) =>
      Date.parse(a.submitted_at ?? "") - Date.parse(b.submitted_at ?? "")
  );
  for (const r of ordered) {
    const who = r.user?.login;
    if (!who) continue;
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") {
      latest.set(who, r.state);
    } else if (r.state === "DISMISSED") {
      latest.delete(who);
    }
  }
  const approved: string[] = [];
  const changesRequested: string[] = [];
  for (const [who, state] of latest) {
    (state === "APPROVED" ? approved : changesRequested).push(who);
  }
  return { approved, changesRequested };
}

export function approvalsLabel(s: ApprovalSummary): string {
  if (s.changesRequested.length > 0) {
    return `${s.changesRequested.length} requested changes`;
  }
  if (s.approved.length > 0) return `${s.approved.length} approved`;
  return "None yet";
}

type MergeState = {
  state: string;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
};

export type MergeHeadline = {
  tone: "ok" | "bad" | "neutral" | "merged";
  title: string;
  detail: string;
};

/** The merge box's headline, from GitHub's (asynchronously computed)
 *  mergeability. */
export function mergeHeadline(
  pr: MergeState,
  checks: CheckSummary
): MergeHeadline {
  if (pr.merged) {
    return {
      tone: "merged",
      title: "Merged",
      detail: "This pull request has been merged.",
    };
  }
  if (pr.state !== "open") {
    return {
      tone: "neutral",
      title: "Closed",
      detail: "This pull request is closed.",
    };
  }
  if (pr.mergeable === false || pr.mergeable_state === "dirty") {
    return {
      tone: "bad",
      title: "Merge conflicts",
      detail: "Resolve the merge conflicts before this can merge.",
    };
  }
  if (pr.mergeable == null || pr.mergeable_state === "unknown") {
    return {
      tone: "neutral",
      title: "Checking mergeability",
      detail: "GitHub is still working this out.",
    };
  }
  if (pr.mergeable_state === "blocked") {
    return {
      tone: "bad",
      title: "Merging is blocked",
      detail: "A required check or review hasn't been satisfied yet.",
    };
  }
  if (pr.mergeable_state === "behind") {
    return {
      tone: "neutral",
      title: "Out of date",
      detail: "This branch is behind its base branch.",
    };
  }
  if (checks.failing > 0 || pr.mergeable_state === "unstable") {
    return {
      tone: "neutral",
      title: "Ready to merge",
      detail: "Some checks aren't passing, but they aren't required.",
    };
  }
  return {
    tone: "ok",
    title: "Ready to merge",
    detail: "No conflicts with the base branch.",
  };
}
