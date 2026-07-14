import { apiFetchJson } from "./client";

// Only the fields the UI shows are typed.
export type GithubRepo = {
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  private: boolean;
  default_branch: string;
  language: string | null;
  updated_at: string;
};

// The proxy mirrors GitHub's status, so a missing server GITHUB_TOKEN yields a
// 401 unrelated to our session. `preserve401`, here and on every proxied call
// below, keeps that from tripping client session-expiry; callers catch instead.
export const listGithubRepos = () =>
  apiFetchJson<GithubRepo[]>(
    "/api/github/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
    { preserve401: true }
  );

// A personal caller gets their own repos when connected, else `connected: false`
// so the UI prompts to connect. Org and platform callers see shared-token repos
// and are always `connected: true`.
export type ImportableReposResult = {
  connected: boolean;
  repos: GithubRepo[];
};
export const listImportableRepos = () =>
  apiFetchJson<ImportableReposResult>("/api/github-importable-repos", {
    preserve401: true,
  });

// Per-user GitHub OAuth (personal accounts). Mirrors the Gmail connect flow.
export const getGithubConnectUrl = async () => {
  const data = await apiFetchJson<{ url: string }>(
    "/api/github-oauth/connect",
    { method: "POST" }
  );
  return data.url;
};

export type GithubConnection = { connected: boolean; login?: string };
export const getGithubConnection = () =>
  apiFetchJson<GithubConnection>("/api/github-oauth/connection", {
    preserve401: true,
  });

export const disconnectGithub = () =>
  apiFetchJson<{ disconnected: boolean }>("/api/github-oauth/connect", {
    method: "DELETE",
  });

// Filtered server-side: a non-admin platform member sees only the repos granted
// to them. Prefer this over `listGithubRepos` on the Projects page so the filter
// is really enforced rather than being a client-side hide.
export type VisibleProjects = { unrestricted: boolean; repos: GithubRepo[] };
export const getVisibleProjects = () =>
  apiFetchJson<VisibleProjects>("/api/projects/visible", { preserve401: true });

// Per-repo language breakdown, in bytes; `topLanguages` reduces it.
export const getRepoLanguages = (owner: string, repo: string) =>
  apiFetchJson<Record<string, number>>(
    `/api/github/repos/${owner}/${repo}/languages`,
    { preserve401: true }
  );

// `author` is the GitHub user, null when the commit email matches no account;
// `commit.author` is the raw git author and is always present.
export type GithubCommit = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  author: { login: string; avatar_url: string } | null;
};

export const getRecentCommits = (owner: string, repo: string, perPage = 5) =>
  apiFetchJson<GithubCommit[]>(
    `/api/github/repos/${owner}/${repo}/commits?per_page=${perPage}`,
    { preserve401: true }
  );

export const topLanguages = (langs: Record<string, number>, n = 2): string[] =>
  Object.entries(langs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name]) => name);

// Owner-only. The thrown error carries GitHub's own message, which callers
// surface verbatim (e.g. "Can not approve your own pull request.").
export const approvePullRequest = (
  owner: string,
  repo: string,
  prNumber: number,
  message?: string
) =>
  apiFetchJson<{ state?: string; html_url?: string }>(
    `/api/github/repos/${owner}/${repo}/pulls/${prNumber}/approve`,
    {
      method: "POST",
      body: JSON.stringify({ body: message ?? undefined }),
      preserve401: true,
    }
  );

export type MergeMethod = "merge" | "squash" | "rebase";

// Owner-only. The thrown error carries GitHub's own message, which callers
// surface verbatim (e.g. "Pull Request is not mergeable.").
export const mergePullRequest = (
  owner: string,
  repo: string,
  prNumber: number,
  mergeMethod: MergeMethod = "merge"
) =>
  apiFetchJson<{ merged?: boolean; sha?: string; message?: string }>(
    `/api/github/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
    {
      method: "PUT",
      body: JSON.stringify({ merge_method: mergeMethod }),
      preserve401: true,
    }
  );

// Post a conversation comment on a commit. Note that it is attributed to the
// shared server token's GitHub account, not to the individual app user.
export const createCommitComment = (
  owner: string,
  repo: string,
  sha: string,
  body: string
) =>
  apiFetchJson<{
    id: number;
    user: { login: string } | null;
    body: string | null;
    created_at: string;
  }>(`/api/github/repos/${owner}/${repo}/commits/${sha}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
    preserve401: true,
  });
