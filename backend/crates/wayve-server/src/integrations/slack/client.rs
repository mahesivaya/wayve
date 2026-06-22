//! Thin Slack Web API client. Mirrors the Jira client: the shared `HTTP_CLIENT`,
//! a base URL overridable for tests via `external::slack_api_base`, and bot-token
//! bearer auth. Slack signals failure with HTTP 200 + `"ok": false`, so each
//! method checks `ok` rather than the HTTP status.

use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use serde::de::DeserializeOwned;
use std::time::Duration;
use tracing::warn;

use super::models::{
    SlackAuthTest, SlackChannel, SlackConnection, SlackConversationsList, SlackHistory,
    SlackMessage, SlackPostMessage, SlackUserInfo,
};

pub struct SlackClient {
    base: String,
    token: String,
}

impl SlackClient {
    pub fn new(conn: &SlackConnection) -> Self {
        Self::from_token(&conn.bot_token)
    }

    pub fn from_token(token: &str) -> Self {
        Self {
            base: crate::external::slack_api_base(),
            token: token.to_string(),
        }
    }

    fn url(&self, method: &str) -> String {
        format!("{}/{}", self.base.trim_end_matches('/'), method)
    }

    async fn get_json<T: DeserializeOwned>(
        &self,
        method: &str,
        query: &[(&str, String)],
    ) -> Result<T, AppError> {
        let resp = HTTP_CLIENT
            .get(self.url(method))
            .timeout(Duration::from_secs(20))
            .bearer_auth(&self.token)
            .query(query)
            .send()
            .await
            .map_err(|e| {
                warn!(target: "worker", error = ?e, method, "slack request transport error");
                AppError::Internal("Slack upstream call failed".into())
            })?;
        resp.json::<T>().await.map_err(|e| {
            warn!(target: "worker", error = ?e, method, "slack response decode error");
            AppError::Internal("Slack response decode failed".into())
        })
    }

    async fn post_form<T: DeserializeOwned>(
        &self,
        method: &str,
        form: &[(&str, String)],
    ) -> Result<T, AppError> {
        let resp = HTTP_CLIENT
            .post(self.url(method))
            .timeout(Duration::from_secs(20))
            .bearer_auth(&self.token)
            .form(form)
            .send()
            .await
            .map_err(|e| {
                warn!(target: "worker", error = ?e, method, "slack request transport error");
                AppError::Internal("Slack upstream call failed".into())
            })?;
        resp.json::<T>().await.map_err(|e| {
            warn!(target: "worker", error = ?e, method, "slack response decode error");
            AppError::Internal("Slack response decode failed".into())
        })
    }

    /// `auth.test` — validate the bot token. Returns `(team_name, team_id)`.
    /// A `false` `ok` means the token is bad → `Unauthorized`.
    pub async fn auth_test(&self) -> Result<(Option<String>, Option<String>), AppError> {
        let r: SlackAuthTest = self.get_json("auth.test", &[]).await?;
        if !r.ok {
            warn!(target: "worker", error = ?r.error, "slack auth.test rejected token");
            return Err(AppError::Unauthorized);
        }
        Ok((r.team, r.team_id))
    }

    /// `conversations.list` — the workspace's channels the bot can see. Listing
    /// **private** channels needs the `groups:read` scope on top of
    /// `channels:read`; if the bot only has `channels:read`, Slack rejects the
    /// combined call with `missing_scope`, so we fall back to public channels.
    pub async fn list_channels(&self) -> Result<Vec<SlackChannel>, AppError> {
        match self
            .list_channels_of("public_channel,private_channel")
            .await
        {
            Ok(channels) => Ok(channels),
            Err(_) => self.list_channels_of("public_channel").await,
        }
    }

    async fn list_channels_of(&self, types: &str) -> Result<Vec<SlackChannel>, AppError> {
        let r: SlackConversationsList = self
            .get_json(
                "conversations.list",
                &[
                    ("types", types.to_string()),
                    ("exclude_archived", "true".to_string()),
                    ("limit", "200".to_string()),
                ],
            )
            .await?;
        if !r.ok {
            let err = r.error.unwrap_or_default();
            warn!(target: "worker", error = %err, types, "slack conversations.list failed");
            // Surface the Slack error to the caller (e.g. `missing_scope`,
            // `invalid_auth`) instead of a generic 500, so it's actionable.
            return Err(AppError::bad_request(format!("Slack error: {err}")));
        }
        Ok(r.channels)
    }

    /// `conversations.history` — messages in a channel, newest first. `oldest`
    /// (a Slack `ts`) bounds the pull so re-imports only fetch new messages.
    pub async fn history(
        &self,
        channel: &str,
        oldest: Option<&str>,
        limit: u32,
    ) -> Result<Vec<SlackMessage>, AppError> {
        let mut query = vec![
            ("channel", channel.to_string()),
            ("limit", limit.clamp(1, 200).to_string()),
        ];
        if let Some(o) = oldest {
            query.push(("oldest", o.to_string()));
        }
        let r: SlackHistory = self.get_json("conversations.history", &query).await?;
        if !r.ok {
            return Err(AppError::Internal(format!(
                "Slack conversations.history failed: {}",
                r.error.unwrap_or_default()
            )));
        }
        Ok(r.messages)
    }

    /// `users.info` — best-effort display name for a Slack user id. Returns
    /// `None` on any failure (the caller falls back to the raw id).
    pub async fn user_name(&self, user_id: &str) -> Option<String> {
        let r: SlackUserInfo = self
            .get_json("users.info", &[("user", user_id.to_string())])
            .await
            .ok()?;
        let user = r.user?;
        user.real_name
            .filter(|s| !s.is_empty())
            .or(user.name)
            .filter(|s| !s.is_empty())
    }

    /// Resolve Slack markup in a message to readable text: user mentions
    /// `<@U…>` / `<@U…|name>` → `@name` (bare ids are looked up via `users.info`),
    /// channel refs `<#C…|name>` → `#name`, and links `<url|label>` → `label`.
    /// UTF-8-safe manual scan (no regex dep); leaves plain text untouched.
    pub async fn resolve_mentions(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(start) = rest.find('<') {
            out.push_str(&rest[..start]);
            let after = &rest[start..];
            if let Some(end) = after.find('>') {
                out.push_str(&self.format_token(&after[1..end]).await);
                rest = &after[end + 1..];
            } else {
                out.push('<');
                rest = &after[1..];
            }
        }
        out.push_str(rest);
        out
    }

    async fn format_token(&self, inner: &str) -> String {
        if let Some(user) = inner.strip_prefix('@') {
            // `<@U…|name>` carries the name; `<@U…>` needs a users.info lookup.
            if let Some((_, name)) = user.split_once('|') {
                return format!("@{name}");
            }
            let name = self
                .user_name(user)
                .await
                .unwrap_or_else(|| user.to_string());
            return format!("@{name}");
        }
        if let Some(channel) = inner.strip_prefix('#') {
            let name = channel.split_once('|').map(|(_, n)| n).unwrap_or(channel);
            return format!("#{name}");
        }
        // Link form `<url|label>` / `<url>`.
        match inner.split_once('|') {
            Some((url, "")) => url.to_string(),
            Some((_, label)) => label.to_string(),
            None => inner.to_string(),
        }
    }

    /// `chat.postMessage` — post `text` to a Slack channel (outbound bridge).
    ///
    /// When `username` is set, the message is posted under that display name (the
    /// Wayve sender) instead of the bot's own name, via Slack's per-message
    /// `username`/`icon_emoji` override. That override needs the
    /// `chat:write.customize` bot scope; if the workspace hasn't reinstalled with
    /// it, Slack rejects the call — we detect that and retry once as a plain bot
    /// post so outbound bridging never silently breaks.
    pub async fn post_message(
        &self,
        channel: &str,
        text: &str,
        username: Option<&str>,
    ) -> Result<(), AppError> {
        let name = username.map(str::trim).filter(|s| !s.is_empty());

        let mut form = vec![("channel", channel.to_string()), ("text", text.to_string())];
        if let Some(name) = name {
            form.push(("username", name.to_string()));
            form.push(("icon_emoji", ":speech_balloon:".to_string()));
        }

        let r: SlackPostMessage = self.post_form("chat.postMessage", &form).await?;
        if !r.ok {
            let err = r.error.unwrap_or_default();
            // Workspace lacks chat:write.customize (or it's an older token type) →
            // retry as a plain bot post so the message still reaches Slack.
            if name.is_some()
                && matches!(
                    err.as_str(),
                    "missing_scope" | "restricted_action" | "not_allowed_token_type"
                )
            {
                warn!(target: "worker", error = %err, "slack custom-username post rejected; retrying as plain bot post");
                return Box::pin(self.post_message(channel, text, None)).await;
            }
            return Err(AppError::Internal(format!(
                "Slack chat.postMessage failed: {err}"
            )));
        }
        Ok(())
    }
}
