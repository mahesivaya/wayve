import { apiFetchJson } from "./client";

export type DocSummary = {
  slug: string;
  title: string;
  description: string;
};

export type DocFull = DocSummary & { body: string };

export const listDocs = () =>
  apiFetchJson<DocSummary[]>("/api/docs", { auth: false });

export const getDoc = (slug: string) =>
  apiFetchJson<DocFull>(`/api/docs/${encodeURIComponent(slug)}`, { auth: false });
