import { apiFetchJson } from "./client";

// A repository as returned by GitHub's `/user/repos`, proxied through
// `/api/github/...`. Only the fields the UI shows are typed.
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

// Every repository the server token can see, most-recently-updated first.
// Allowed for platform callers (the proxy permits any tail for platform).
//
// `preserve401` is critical: the proxy MIRRORS GitHub's status, and
// `/user/repos` is a GitHub-authenticated endpoint — if the server's
// GITHUB_TOKEN is missing/invalid, GitHub returns 401. Without preserve401 that
// would trip the client's session-expiry (logging the user out of OUR app) for
// a purely GitHub-side problem. Callers catch the throw and degrade gracefully.
export const listGithubRepos = () =>
  apiFetchJson<GithubRepo[]>(
    "/api/github/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
    { preserve401: true }
  );

// Per-repo language breakdown: `{ "TypeScript": 12345, "CSS": 678, ... }` in
// bytes. Use `topLanguages` to reduce it to the dominant few.
export const getRepoLanguages = (owner: string, repo: string) =>
  apiFetchJson<Record<string, number>>(
    `/api/github/repos/${owner}/${repo}/languages`,
    { preserve401: true }
  );

// The `n` most-used languages (by bytes), highest first.
export const topLanguages = (
  langs: Record<string, number>,
  n = 2
): string[] =>
  Object.entries(langs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name]) => name);
