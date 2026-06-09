import { apiFetch, apiFetchJson } from "./client";

// Organization-scoped projects + teams shown in the app sidebar. Listing is
// available to any org member; creation/rename is org-owner-only (enforced by
// the backend require_owner gate — the UI just hides the controls otherwise).

export type Project = {
  id: number;
  name: string;
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

export const createProject = async (name: string) => {
  const res = await apiFetch("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message ?? "Failed to create project");
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
