import { apiFetchJson } from "./client";

// Mirrors backend/crates/wayve-server/src/home/handler.rs::HomeSummary.
// One round-trip replaces 4-6 separate fetches the dashboard used to do
// (full inbox, all meetings, all tasks, all notes); the server bounds each
// query to LIMIT 5 and runs them in parallel.

export type MeetingPreview = {
  id: number;
  title: string;
  start_time: string;
  end_time: string;
  participants_count: number;
};

export type EmailPreview = {
  id: number;
  sender: string | null;
  subject: string | null;
  created_at: string | null;
};

export type TaskPreview = {
  id: number;
  name: string;
  status: string;
};

export type RecentItem =
  | { kind: "note"; id: number; title: string | null; ts: string | null }
  | { kind: "email"; id: number; title: string | null; ts: string | null };

export type HomeSummary = {
  today: { events: MeetingPreview[] };
  inbox: { unread_count: number; preview: EmailPreview[] };
  tasks: { top: TaskPreview[] };
  recent: RecentItem[];
};

export const getHomeSummary = () =>
  apiFetchJson<HomeSummary>("/api/home/summary");
