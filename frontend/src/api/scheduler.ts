import { apiFetch } from "./client";

const browserTz = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export type MeetingPayload = {
  title: string;
  date: string;
  start: number;
  end: number;
  participants: string[];
};

// Wire shape of a meeting row. `date` and `start_time`/`end_time` are naive
// local wall-clock ("YYYY-MM-DD" and "HH:MM[:SS]") — there is no stored zone, so
// they're interpreted in the viewer's local zone, matching src/utils/datetime.ts.
export type ApiMeeting = {
  id: number;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  participants?: string[];
  zoom_join_url?: string | null;
  source?: string;
};

export const getMeetings = async (): Promise<ApiMeeting[]> => {
  const res = await apiFetch("/api/meetings");
  return res.json();
};

export const createMeetingApi = async (data: MeetingPayload) => {
  const res = await apiFetch("/api/meetings", {
    method: "POST",
    body: JSON.stringify({
      ...data,
      participants: data.participants ?? [],
      tz: browserTz(),
    }),
  });

  return res.json();
};

export const updateMeetingApi = async (id: number, data: MeetingPayload) => {
  const res = await apiFetch(`/api/meetings/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      ...data,
      participants: data.participants ?? [],
      tz: browserTz(),
    }),
  });

  return res.json();
};

export const createMeetingLinkApi = async (): Promise<{ join_url: string }> => {
  const res = await apiFetch("/api/meetings/link", { method: "POST" });
  if (!res.ok)
    throw new Error(res.status === 503 ? "not_configured" : "failed");
  return res.json();
};

export const deleteMeetingApi = async (id: number) => {
  const res = await apiFetch(`/api/meetings/${id}`, {
    method: "DELETE",
  });

  return res.json();
};
