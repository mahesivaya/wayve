import { apiFetch, apiFetchJson } from "./client";
import { announceProjectsChanged } from "./projectsChanged";

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

export type TeamMember = {
  id: number;
  name: string;
  role: string | null;
  email: string | null;
  joined_at?: string | null;
  // Every team in the org this person is on, matched by email.
  teams?: string[];
};

export type Team = {
  id: number;
  name: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  // Present on GET /api/teams/{slug}; the list endpoint omits it.
  members?: TeamMember[];
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
  const created = (await res.json()) as Project;
  announceProjectsChanged();
  return created;
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
  const linked = (await res.json()) as Project;
  announceProjectsChanged();
  return linked;
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
  const renamed = (await res.json()) as Project;
  announceProjectsChanged();
  return renamed;
};

export const deleteProject = async (id: number) => {
  const res = await apiFetch(`/api/projects/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message ?? "Failed to delete project");
  }
  announceProjectsChanged();
};

export const listTeams = async () => apiFetchJson<Team[]>("/api/teams");

export const getTeam = async (slug: string) =>
  apiFetchJson<Team>(`/api/teams/${encodeURIComponent(slug)}`);

// Fires `rwayve:team-deleted` so the sidebar's team list (owned by Layout)
// drops the team without a refetch.
export const deleteTeam = async (id: number) => {
  const res = await apiFetch(`/api/teams/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message ?? "Failed to delete team");
  }
  window.dispatchEvent(
    new CustomEvent("rwayve:team-deleted", { detail: { id } })
  );
};

// A blank description clears it.
export const updateTeamDescription = async (
  teamId: number,
  description: string
) => {
  const res = await apiFetch(`/api/teams/${teamId}`, {
    method: "PATCH",
    body: JSON.stringify({ description }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message ?? "Failed to save description");
  }
  return res.json() as Promise<Team>;
};

export const addTeamMember = async (
  teamId: number,
  input: { name: string; role?: string; email?: string }
) => {
  const res = await apiFetch(`/api/teams/${teamId}/members`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message ?? "Failed to add member");
  }
  return res.json() as Promise<TeamMember>;
};

export const removeTeamMember = async (teamId: number, memberId: number) => {
  const res = await apiFetch(`/api/teams/${teamId}/members/${memberId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message ?? "Failed to remove member");
  }
};

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
