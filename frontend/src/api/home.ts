import { apiFetchJson } from "./client";

// Each card on /home calls its own endpoint, so the fast queries paint
// immediately and the slow ones, which join and AES-decrypt, stream in when
// ready. Prefer these over the legacy aggregate `/api/home/summary`.

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

export type TodaySummary = { events: MeetingPreview[] };
export type InboxSummary = { unread_count: number; preview: EmailPreview[] };
export type TasksSummary = { top: TaskPreview[] };

export type HomeSummary = {
  today: TodaySummary;
  inbox: InboxSummary;
  tasks: TasksSummary;
  recent: RecentItem[];
};

export const getHomeToday = () => apiFetchJson<TodaySummary>("/api/home/today");

export const getHomeInbox = () => apiFetchJson<InboxSummary>("/api/home/inbox");

export const getHomeTasks = () => apiFetchJson<TasksSummary>("/api/home/tasks");

export const getHomeRecent = () =>
  apiFetchJson<RecentItem[]>("/api/home/recent");

/** @deprecated Prefer the per-card endpoints (`getHomeToday`, …). */
export const getHomeSummary = () =>
  apiFetchJson<HomeSummary>("/api/home/summary");
