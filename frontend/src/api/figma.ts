import { apiFetch, apiFetchJson } from "./client";

// Per-user Figma connection. The token never reaches the browser — only who it
// belongs to, for the "Connected as …" line.
export type FigmaConnectionStatus = {
  connected: boolean;
  handle?: string;
  email?: string | null;
};

export const getFigmaConnection = async () =>
  apiFetchJson<FigmaConnectionStatus>("/api/figma-oauth/connection");

// Ask for the authorize URL and send the browser there; Figma redirects back to
// /figma/oauth/callback, which stores the token.
export const getFigmaConnectUrl = async () => {
  const data = await apiFetchJson<{ url: string }>("/api/figma-oauth/connect", {
    method: "POST",
  });
  return data.url;
};

export const disconnectFigma = async () => {
  await apiFetch("/api/figma-oauth/connect", { method: "DELETE" });
};

// A design attached to a board item. Only a reference: the metadata is captured
// once at attach time so the board draws without calling Figma.
export type FigmaLink = {
  id: number;
  file_key: string;
  node_id: string | null;
  url: string;
  name: string;
  thumbnail_url: string | null;
  file_modified_at: string | null;
};

/** Exactly one of these identifies which board item the designs belong to. */
export type FigmaLinkOwner = { ticketId?: number; userStoryId?: number };

const ownerQuery = (owner: FigmaLinkOwner) =>
  owner.ticketId != null
    ? `ticket_id=${owner.ticketId}`
    : `user_story_id=${owner.userStoryId}`;

export const listFigmaLinks = async (owner: FigmaLinkOwner) =>
  apiFetchJson<FigmaLink[]>(`/api/figma/links?${ownerQuery(owner)}`);

export const createFigmaLink = async (url: string, owner: FigmaLinkOwner) =>
  apiFetchJson<FigmaLink>("/api/figma/links", {
    method: "POST",
    body: JSON.stringify({
      url,
      ticket_id: owner.ticketId ?? null,
      user_story_id: owner.userStoryId ?? null,
    }),
  });

export const deleteFigmaLink = async (id: number) => {
  await apiFetch(`/api/figma/links/${id}`, { method: "DELETE" });
};
