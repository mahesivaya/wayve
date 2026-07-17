import { apiFetch, apiFetchJson } from "./client";

export type Reminder = {
  id: number;
  title: string;
  notes: string | null;
  // Naive local wall-clock time, e.g. "2026-07-18T14:30:00".
  remind_at: string;
  created_at?: string | null;
};

export type ReminderInput = {
  title: string;
  notes?: string | null;
  // "YYYY-MM-DDTHH:MM" from an <input type="datetime-local">.
  remind_at: string;
};

export const getReminders = async () =>
  apiFetchJson<Reminder[]>("/api/reminders");

export const createReminder = async (data: ReminderInput) => {
  const res = await apiFetch("/api/reminders", {
    method: "POST",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("create_reminder_failed");
  return res.json() as Promise<Reminder>;
};

export const deleteReminder = async (id: number) => {
  const res = await apiFetch(`/api/reminders/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("delete_reminder_failed");
  return res.json();
};
