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

// The OAuth path: ask for the authorize URL and send the browser there. Slack
// redirects back to /slack/oauth/callback, which stores the granted bot token.
// Preferred over connectSlack below — nobody should have to make a Slack app by
// hand to use this.
export const getSlackConnectUrl = async () => {
  const data = await apiFetchJson<{ url: string }>("/api/slack-oauth/connect", {
    method: "POST",
  });
  return data.url;
};

// The manual path, kept for a workspace whose admin would rather paste a bot
// token than install the OAuth app (self-hosted Slack apps, restricted
// installs). The OAuth callback writes the same row.
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
