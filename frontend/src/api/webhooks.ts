import { apiFetch, apiFetchJson } from "./client";

export type WebhookEndpoint = {
  id: number;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  org_wide: boolean;
  organization_id: number | null;
  secret_preview: string;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string | null;
};

// Returned only by POST /api/webhooks at creation — the raw secret is shown once.
export type CreatedWebhookEndpoint = WebhookEndpoint & { secret: string };

export type WebhookDelivery = {
  id: number;
  event_id: string;
  event_type: string;
  attempt_count: number;
  status: "pending" | "delivered" | "failed" | "abandoned";
  http_status: number | null;
  response_excerpt: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string | null;
};

export type CreateWebhookInput = {
  url: string;
  events: string[];
  description?: string;
  org_wide?: boolean;
};

export type UpdateWebhookInput = {
  url?: string;
  events?: string[];
  description?: string;
  enabled?: boolean;
};

export const listWebhooks = () =>
  apiFetchJson<WebhookEndpoint[]>("/api/webhooks");

export const listEventCatalog = () =>
  apiFetchJson<{ events: string[]; api_version: string }>(
    "/api/webhooks/events",
  );

export const createWebhook = (input: CreateWebhookInput) =>
  apiFetchJson<CreatedWebhookEndpoint>("/api/webhooks", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const updateWebhook = (id: number, input: UpdateWebhookInput) =>
  apiFetchJson<WebhookEndpoint>(`/api/webhooks/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });

export const deleteWebhook = (id: number) =>
  apiFetch(`/api/webhooks/${id}`, { method: "DELETE" });

export const testWebhook = (id: number) =>
  apiFetchJson<{ queued: boolean }>(`/api/webhooks/${id}/test`, {
    method: "POST",
  });

export const listDeliveries = (id: number) =>
  apiFetchJson<WebhookDelivery[]>(`/api/webhooks/${id}/deliveries`);
