//! Thin Slack Web API client, mirroring the Jira client: the shared
//! `HTTP_CLIENT`, a base URL overridable for tests via `external::slack_api_base`,
//! and bot-token bearer auth. Slack signals failure with HTTP 200 and
//! `"ok": false`, so every method checks `ok` rather than the HTTP status.

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

    /// Validate the bot token, returning `(team_name, team_id)`. A `false` `ok`
    /// means the token is bad.
    pub async fn auth_test(&self) -> Result<(Option<String>, Option<String>), AppError> {
        let r: SlackAuthTest = self.get_json("auth.test", &[]).await?;
        if !r.ok {
            warn!(target: "worker", error = ?r.error, "slack auth.test rejected token");
            return Err(AppError::Unauthorized);
        }
        Ok((r.team, r.team_id))
    }

    /// The workspace channels the bot can see. Listing private channels needs the
    /// `groups:read` scope on top of `channels:read`, and Slack rejects the
    /// combined call with `missing_scope` when it is absent, so fall back to
    /// public channels.
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
            // Surfacing the Slack error code rather than a generic 500 is what
            // makes `missing_scope` and `invalid_auth` actionable for the admin.
            return Err(AppError::bad_request(format!("Slack error: {err}")));
        }
        Ok(r.channels)
    }

    /// Messages in a channel, newest first. `oldest` (a Slack `ts`) bounds the
    /// pull so re-imports only fetch new messages.
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

    /// Best-effort display name for a Slack user id. `None` on any failure; the
    /// caller falls back to the raw id.
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

    /// Resolve Slack markup in a message to readable text: user mentions, channel
    /// references, and links. A bare user id needs a `users.info` lookup. The scan
    /// is manual and UTF-8-safe to avoid a regex dependency.
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
        match inner.split_once('|') {
            Some((url, "")) => url.to_string(),
            Some((_, label)) => label.to_string(),
            None => inner.to_string(),
        }
    }

    /// Post `text` to a Slack channel, the outbound bridge.
    ///
    /// A `username` posts under the Wayve sender's display name instead of the
    /// bot's, via Slack's per-message override. No `icon_*` override is sent, so
    /// Slack uses its default avatar and the message reads like any other user's.
    /// The override needs the `chat:write.customize` bot scope; a workspace that
    /// hasn't reinstalled with it has the call rejected, so we retry once as a
    /// plain bot post rather than let outbound bridging silently break.
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
        }

        let r: SlackPostMessage = self.post_form("chat.postMessage", &form).await?;
        if !r.ok {
            let err = r.error.unwrap_or_default();
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
