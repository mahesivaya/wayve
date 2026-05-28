import { getApiBase } from "../config/env";
import { getAuthToken } from "../auth/token";
import { apiFetch, apiFetchJson } from "./client";

export type TicketCategory = "bug" | "feature" | "billing" | "account" | "other";
export type TicketStatus = "open" | "in_progress" | "resolved" | "closed";

export type SupportTicket = {
  id: number;
  user_id: number;
  user_email: string | null;
  organization_id: number | null;
  organization_name: string | null;
  subject: string;
  description: string;
  category: TicketCategory;
  status: TicketStatus;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  attachment_count: number;
};

export type SupportAttachment = {
  id: number;
  ticket_id: number;
  name: string;
  file_type: string | null;
  size: number;
  created_at: string;
};

export type CreateTicketBody = {
  subject: string;
  description: string;
  category: TicketCategory;
};

export const createTicket = async (body: CreateTicketBody) =>
  apiFetchJson<{ id: number }>("/api/support/tickets", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const listMyTickets = async () =>
  apiFetchJson<SupportTicket[]>("/api/support/tickets");

export const getTicket = async (id: number) =>
  apiFetchJson<SupportTicket>(`/api/support/tickets/${id}`);

export const adminListTickets = async (status?: TicketStatus) => {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiFetchJson<SupportTicket[]>(`/api/support/admin/tickets${qs}`);
};

export const adminUpdateTicketStatus = async (id: number, status: TicketStatus) =>
  apiFetchJson<{ id: number; status: TicketStatus }>(
    `/api/support/admin/tickets/${id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status }),
    },
  );

export const listTicketAttachments = async (ticketId: number) =>
  apiFetchJson<SupportAttachment[]>(`/api/support/tickets/${ticketId}/attachments`);

// Raw fetch — multipart boundary needs to be set by the browser, which
// apiFetch's pinned application/json Content-Type would override.
export const uploadTicketAttachments = async (
  ticketId: number,
  files: File[],
): Promise<SupportAttachment[]> => {
  if (files.length === 0) return [];
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  const token = getAuthToken();
  const res = await fetch(
    `${getApiBase()}/api/support/tickets/${ticketId}/attachments`,
    {
      method: "POST",
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: formData,
    },
  );

  if (!res.ok) {
    let message = "Attachment upload failed";
    try {
      const data = await res.clone().json();
      message = data?.message || data?.error || message;
    } catch {
      const text = await res.text();
      if (text) message = text;
    }
    throw new Error(message);
  }

  return res.json();
};

export const downloadTicketAttachment = async (attachmentId: number) => {
  const token = getAuthToken();
  const res = await fetch(
    `${getApiBase()}/api/support-attachments/${attachmentId}/download`,
    {
      method: "GET",
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    },
  );
  if (!res.ok) throw new Error("Download failed");
  return res.blob();
};

export const deleteTicketAttachment = async (attachmentId: number) => {
  await apiFetch(`/api/support-attachments/${attachmentId}`, { method: "DELETE" });
};
