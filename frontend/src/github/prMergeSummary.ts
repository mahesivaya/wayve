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
  /** The check's page on GitHub (its Actions job page for workflow jobs). */
  html_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
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

export type CheckOutcome = "pass" | "fail" | "pending" | "skip";

export function checkOutcome(run: CheckRun): CheckOutcome {
  if (run.status !== "completed" || !run.conclusion) return "pending";
  if (PASSED.has(run.conclusion)) return "pass";
  if (SKIPPED.has(run.conclusion)) return "skip";
  return "fail";
}

export function summarizeChecks(runs: CheckRun[]): CheckSummary {
  const s = {
    total: runs.length,
    passed: 0,
    failing: 0,
    pending: 0,
    skipped: 0,
  };
  for (const run of runs) {
    const o = checkOutcome(run);
    if (o === "pending") s.pending += 1;
    else if (o === "pass") s.passed += 1;
    else if (o === "skip") s.skipped += 1;
    else s.failing += 1;
  }
  return s;
}

const OUTCOME_ORDER: Record<CheckOutcome, number> = {
  fail: 0,
  pending: 1,
  pass: 2,
  skip: 3,
};

/** Failing first, then pending, passed, skipped; by name within each. */
export function sortChecks(runs: CheckRun[]): CheckRun[] {
  return [...runs].sort(
    (a, b) =>
      OUTCOME_ORDER[checkOutcome(a)] - OUTCOME_ORDER[checkOutcome(b)] ||
      a.name.localeCompare(b.name, undefined, { numeric: true })
  );
}

/** "9m 10s", "14s", "1h 2m" — how long a finished check ran. */
export function checkDuration(run: CheckRun): string | null {
  if (!run.started_at || !run.completed_at) return null;
  const secs = Math.round(
    (Date.parse(run.completed_at) - Date.parse(run.started_at)) / 1000
  );
  if (!Number.isFinite(secs) || secs < 0) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const sec = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
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
  html_url?: string;
};

export type Verdict = {
  login: string;
  state: "APPROVED" | "CHANGES_REQUESTED";
  submitted_at: string | null;
  html_url?: string;
};

/** Each reviewer's latest verdict, as GitHub counts it: a later APPROVED or
 *  CHANGES_REQUESTED replaces an earlier one, DISMISSED clears it, and plain
 *  COMMENTED reviews don't change it. Oldest verdict first. */
export function latestVerdicts(reviews: Review[]): Verdict[] {
  const latest = new Map<string, Verdict>();
  const ordered = [...reviews].sort(
    (a, b) =>
      Date.parse(a.submitted_at ?? "") - Date.parse(b.submitted_at ?? "")
  );
  for (const r of ordered) {
    const who = r.user?.login;
    if (!who) continue;
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") {
      latest.delete(who);
      latest.set(who, {
        login: who,
        state: r.state,
        submitted_at: r.submitted_at,
        html_url: r.html_url,
      });
    } else if (r.state === "DISMISSED") {
      latest.delete(who);
    }
  }
  return [...latest.values()];
}

export type ApprovalSummary = {
  approved: string[];
  changesRequested: string[];
};

export function summarizeApprovals(reviews: Review[]): ApprovalSummary {
  const verdicts = latestVerdicts(reviews);
  return {
    approved: verdicts
      .filter((v) => v.state === "APPROVED")
      .map((v) => v.login),
    changesRequested: verdicts
      .filter((v) => v.state === "CHANGES_REQUESTED")
      .map((v) => v.login),
  };
}

export function approvalsLabel(s: ApprovalSummary): string {
  if (s.changesRequested.length > 0) {
    return `${s.changesRequested.length} requested changes`;
  }
  if (s.approved.length > 0) return `${s.approved.length} approved`;
  return "None yet";
}
