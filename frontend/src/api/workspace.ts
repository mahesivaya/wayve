import { apiFetch, apiFetchJson } from "./client";

// Organization-scoped projects and teams. Any org member may list them, but
// creating and renaming is owner-only, enforced by the backend require_owner
// gate; the UI merely hides the controls.

export type Project = {
  id: number;
  name: string;
  // The optional linked public GitHub repo, set by a personal account on its
  // own projects or by an org owner on the organization's.
  github_owner?: string | null;
  github_repo?: string | null;
};

export type Team = {
  id: number;
  name: string;
  slug: string;
  tagline: string | null;
  description: string | null;
};

export const listProjects = async () =>
  apiFetchJson<Project[]>("/api/projects");

export const createProject = async (name: string, repoUrl?: string) => {
  const res = await apiFetch("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, repo_url: repoUrl }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message ?? "Failed to create project");
  }
  return res.json() as Promise<Project>;
};

// The server validates that the URL points at a real, public repo, and its 400
// message is user-facing, so callers surface it verbatim.
export const linkProjectRepo = async (id: number, repoUrl: string) => {
  const res = await apiFetch(`/api/projects/${id}/repo`, {
    method: "PATCH",
    body: JSON.stringify({ repo_url: repoUrl }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message ?? "Failed to link repository");
  }
  return res.json() as Promise<Project>;
};

export const updateProject = async (id: number, name: string) => {
  const res = await apiFetch(`/api/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message ?? "Failed to rename project");
  }
  return res.json() as Promise<Project>;
};

export const deleteProject = async (id: number) => {
  const res = await apiFetch(`/api/projects/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message ?? "Failed to delete project");
  }
};

export const listTeams = async () => apiFetchJson<Team[]>("/api/teams");

export const getTeam = async (slug: string) =>
  apiFetchJson<Team>(`/api/teams/${encodeURIComponent(slug)}`);

export const createTeam = async (input: {
  name: string;
  tagline?: string;
  description?: string;
}) => {
  const res = await apiFetch("/api/teams", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message ?? "Failed to create team");
  }
  return res.json() as Promise<Team>;
};
