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

export const getMeetings = async () => {
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

export const deleteMeetingApi = async (id: number) => {
  const res = await apiFetch(`/api/meetings/${id}`, {
    method: "DELETE",
  });

  return res.json();
};
