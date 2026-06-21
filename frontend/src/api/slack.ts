import { apiFetch, apiFetchJson } from "./client";

// Org-wide Slack connection state (enterprise only). The bot token is never
// returned, so there is no token field here.
export type SlackConnectionStatus = {
  connected: boolean;
  team_name: string | null;
  enabled: boolean;
};

export const getSlackConnection = async () =>
  apiFetchJson<SlackConnectionStatus>("/api/integrations/slack/connection");

export const connectSlack = async (botToken: string) =>
  apiFetchJson<SlackConnectionStatus>("/api/integrations/slack/connection", {
    method: "PUT",
    body: JSON.stringify({ bot_token: botToken }),
  });

export const disconnectSlack = async () => {
  await apiFetch("/api/integrations/slack/connection", { method: "DELETE" });
};

export type SlackChannel = { id: string; name: string; is_private: boolean };

export const listSlackChannels = async () =>
  apiFetchJson<SlackChannel[]>("/api/integrations/slack/channels");

export type SlackLinkResult = {
  wayve_channel_id: number;
  name?: string;
  slack_channel_id?: string;
  already_linked?: boolean;
};

// Link a Slack channel to a (freshly created) Wayve channel.
export const linkSlackChannel = async (payload: {
  slack_channel_id: string;
  slack_channel_name?: string;
  wayve_channel_name?: string;
}) =>
  apiFetchJson<SlackLinkResult>("/api/integrations/slack/links", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export type SlackImportResult = { imported: number; channels: number };

// Pull recent history from linked Slack channels into their Wayve channels.
export const importSlack = async (payload?: {
  slack_channel_id?: string;
  limit?: number;
}) =>
  apiFetchJson<SlackImportResult>("/api/integrations/slack/import", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
