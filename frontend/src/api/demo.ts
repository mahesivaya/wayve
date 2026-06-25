import { apiFetch } from "./client";

export type DemoRequestInput = {
  firstName: string;
  lastName: string;
  email: string;
  workEmail: string;
  /** datetime-local value, e.g. "2026-06-25T14:30" (the visitor's local time). */
  slot: string;
};

export type DemoRequestResult = {
  id: number;
  scheduled_at: string;
  emailed: boolean;
};

// Submit a public "Book a demo" request. No auth — anonymous visitors use this.
// The local datetime-local value is converted to a UTC instant so the backend
// (and the .ics invite) records the exact moment the visitor picked.
export async function submitDemoRequest(
  input: DemoRequestInput
): Promise<DemoRequestResult> {
  const scheduledAt = new Date(input.slot).toISOString();
  const res = await apiFetch("/api/demo-requests", {
    method: "POST",
    body: JSON.stringify({
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email,
      work_email: input.workEmail,
      scheduled_at: scheduledAt,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || "Could not submit your request.");
  }
  return data;
}
