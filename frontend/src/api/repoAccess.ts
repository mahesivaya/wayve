import { apiFetchJson } from "./client";

// One row in a repo's access grid. `user_id` is set only for connected members;
// GitHub-only collaborators have a null one and `is_member: false`.
export type RepoAccessRow = {
  user_id: number | null;
  github_login: string | null;
  email: string | null;
  // GitHub's live level for a collaborator, else the Wayve-recorded grant.
  level: "read" | "write" | "admin";
  in_dashboard: boolean;
  is_member: boolean;
  source: "github" | "wayve" | "both";
};

export type RepoAccessResponse = {
  repo: string;
  // False when collaborators could not be read from GitHub, in which case the
  // grid shows only Wayve grants.
  github_readable: boolean;
  can_manage: boolean;
  rows: RepoAccessRow[];
};

export type RepoAccessMutation = {
  dashboard_updated: boolean;
  github_outcome: "synced" | "forbidden" | "failed" | "skipped";
  note?: string;
};

const repoPath = (owner: string, repo: string) =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/access`;

const summaryPath = (owner: string, repo: string) =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/summary`;

export type RepoSummary = { summary: string; can_edit: boolean };

export const getRepoSummary = async (owner: string, repo: string) =>
  apiFetchJson<RepoSummary>(summaryPath(owner, repo));

// Requires manage rights server-side.
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

// Identify the target by `user_id` for a Wayve member, by `github_login` for a
// GitHub-only collaborator, or by both. `in_dashboard` defaults to true.
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

// Target a Wayve member by `user_id` or a GitHub-only collaborator by `login`.
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
