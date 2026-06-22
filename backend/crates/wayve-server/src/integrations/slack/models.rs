use crate::prelude::*;

/// A decrypted Slack connection for an organization, ready for authenticated
/// calls. Never serialized — it carries the plaintext bot token.
pub struct SlackConnection {
    pub organization_id: i32,
    pub bot_token: String,
    pub team_name: Option<String>,
    pub enabled: bool,
}

/// Connection state returned to the frontend. Carries no secret.
#[derive(Serialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub team_name: Option<String>,
    pub enabled: bool,
}

#[derive(Deserialize)]
pub struct ConnectInput {
    /// Slack bot token (`xoxb-…`). Validated with `auth.test` before storage.
    pub bot_token: String,
}

#[derive(Deserialize)]
pub struct LinkInput {
    pub slack_channel_id: String,
    #[serde(default)]
    pub slack_channel_name: Option<String>,
    /// Name for the Wayve channel created for this link; defaults to the Slack
    /// channel name.
    #[serde(default)]
    pub wayve_channel_name: Option<String>,
}

#[derive(Deserialize)]
pub struct ImportInput {
    /// Import only this Slack channel; otherwise every linked channel.
    #[serde(default)]
    pub slack_channel_id: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

// ---- Slack Web API response shapes (only the fields we read) ----
// Slack returns HTTP 200 with `"ok": false` + `"error"` on failure, so callers
// check `ok`, not the HTTP status.

#[derive(Deserialize)]
pub struct SlackAuthTest {
    pub ok: bool,
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Deserialize)]
pub struct SlackConversationsList {
    pub ok: bool,
    #[serde(default)]
    pub channels: Vec<SlackChannel>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct SlackChannel {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub is_private: bool,
}

#[derive(Deserialize)]
pub struct SlackHistory {
    pub ok: bool,
    #[serde(default)]
    pub messages: Vec<SlackMessage>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Deserialize)]
pub struct SlackMessage {
    #[serde(rename = "type", default)]
    pub msg_type: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub ts: String,
    /// Present on non-plain messages (joins, bot posts, edits…). We import only
    /// plain user messages, so a present subtype is skipped.
    #[serde(default)]
    pub subtype: Option<String>,
}

#[derive(Deserialize)]
pub struct SlackUserInfo {
    // `ok` is intentionally omitted: on failure `user` is simply absent and the
    // caller falls back to the raw id, so we read `user` directly.
    #[serde(default)]
    pub user: Option<SlackUser>,
}

#[derive(Deserialize)]
pub struct SlackUser {
    #[serde(default)]
    pub real_name: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Deserialize)]
pub struct SlackPostMessage {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
}

// ---- Slack Events API (inbound webhook) ----

/// The outer envelope Slack POSTs to the Events API request URL. `type` is
/// `url_verification` (carrying `challenge`) or `event_callback` (carrying
/// `event` + `team_id`).
#[derive(Deserialize)]
pub struct SlackEventEnvelope {
    #[serde(rename = "type", default)]
    pub envelope_type: String,
    #[serde(default)]
    pub challenge: Option<String>,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub event: Option<SlackEvent>,
}

/// The inner `event` object. We act only on `type == "message"`. `bot_id` /
/// `app_id` mark messages our own bot posted — skip them to avoid an
/// outbound→inbound echo loop; `subtype` marks joins/edits/etc.
#[derive(Deserialize)]
pub struct SlackEvent {
    #[serde(rename = "type", default)]
    pub event_type: String,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub subtype: Option<String>,
    #[serde(default)]
    pub bot_id: Option<String>,
    #[serde(default)]
    pub app_id: Option<String>,
}
