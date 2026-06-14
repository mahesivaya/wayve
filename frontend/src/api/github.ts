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
export const listGithubRepos = () =>
  apiFetchJson<GithubRepo[]>(
    "/api/github/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member"
  );

// Per-repo language breakdown: `{ "TypeScript": 12345, "CSS": 678, ... }` in
// bytes. Use `topLanguages` to reduce it to the dominant few.
export const getRepoLanguages = (owner: string, repo: string) =>
  apiFetchJson<Record<string, number>>(
    `/api/github/repos/${owner}/${repo}/languages`
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
