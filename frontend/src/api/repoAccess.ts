import { apiFetchJson } from "./client";

// One row in a repo's access grid. `user_id` is set only for connected members
// (assignable in Wayve); GitHub-only collaborators have `user_id: null`.
export type RepoAccessRow = {
  user_id: number | null;
  github_login: string | null;
  email: string | null;
  // read | write | admin — GitHub's live level for a collaborator, else the
  // Wayve-recorded grant level.
  level: "read" | "write" | "admin";
  // Whether the repo shows in this user's Wayve dashboard.
  in_dashboard: boolean;
  // Whether the person maps to a Wayve user (vs. a GitHub-only collaborator).
  is_member: boolean;
  // github | wayve | both
  source: "github" | "wayve" | "both";
};

export type RepoAccessResponse = {
  repo: string;
  // False when we couldn't read collaborators from GitHub (grid shows only
  // Wayve grants + a hint).
  github_readable: boolean;
  can_manage: boolean;
  rows: RepoAccessRow[];
};

export type RepoAccessMutation = {
  dashboard_updated: boolean;
  // synced | forbidden | failed | skipped
  github_outcome: "synced" | "forbidden" | "failed" | "skipped";
  note?: string;
};

const repoPath = (owner: string, repo: string) =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/access`;

const summaryPath = (owner: string, repo: string) =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/summary`;

// The Wayve-local project summary for a repo + whether the caller may edit it.
export type RepoSummary = { summary: string; can_edit: boolean };

export const getRepoSummary = async (owner: string, repo: string) =>
  apiFetchJson<RepoSummary>(summaryPath(owner, repo));

// Save the summary (requires manage rights server-side). Returns the stored
// value + can_edit.
export const setRepoSummary = async (
  owner: string,
  repo: string,
  summary: string
) =>
  apiFetchJson<RepoSummary>(summaryPath(owner, repo), {
    method: "PUT",
    body: JSON.stringify({ summary }),
  });

export const getRepoAccess = async (owner: string, repo: string) =>
  apiFetchJson<RepoAccessResponse>(repoPath(owner, repo));

// Add/update a user's access. Provide `user_id` (a Wayve member) and/or
// `github_login` (for a GitHub-only collaborator). `in_dashboard` controls Wayve
// dashboard visibility (default true server-side).
export const setRepoAccess = async (
  owner: string,
  repo: string,
  payload: {
    user_id?: number;
    github_login?: string;
    level: "read" | "write";
    in_dashboard?: boolean;
  }
) =>
  apiFetchJson<RepoAccessMutation>(repoPath(owner, repo), {
    method: "PUT",
    body: JSON.stringify(payload),
  });

// Remove access for a user (by Wayve `user_id`) or a GitHub-only collaborator
// (by `login`).
export const removeRepoAccess = async (
  owner: string,
  repo: string,
  target: { user_id?: number; login?: string }
) => {
  const params = new URLSearchParams();
  if (target.user_id != null) params.set("user_id", String(target.user_id));
  if (target.login) params.set("login", target.login);
  return apiFetchJson<RepoAccessMutation>(
    `${repoPath(owner, repo)}?${params.toString()}`,
    { method: "DELETE" }
  );
};
