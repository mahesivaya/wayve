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

    /// `conversations.list` — the workspace's channels (public + private the bot
    /// is in).
    pub async fn list_channels(&self) -> Result<Vec<SlackChannel>, AppError> {
        let r: SlackConversationsList = self
            .get_json(
                "conversations.list",
                &[
                    ("types", "public_channel,private_channel".to_string()),
                    ("exclude_archived", "true".to_string()),
                    ("limit", "200".to_string()),
                ],
            )
            .await?;
        if !r.ok {
            return Err(AppError::Internal(format!(
                "Slack conversations.list failed: {}",
                r.error.unwrap_or_default()
            )));
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

    /// `chat.postMessage` — post `text` to a Slack channel (outbound bridge).
    pub async fn post_message(&self, channel: &str, text: &str) -> Result<(), AppError> {
        let r: SlackPostMessage = self
            .post_form(
                "chat.postMessage",
                &[("channel", channel.to_string()), ("text", text.to_string())],
            )
            .await?;
        if !r.ok {
            return Err(AppError::Internal(format!(
                "Slack chat.postMessage failed: {}",
                r.error.unwrap_or_default()
            )));
        }
        Ok(())
    }
}
