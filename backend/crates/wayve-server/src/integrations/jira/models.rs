use crate::prelude::*;

/// A decrypted per-user Jira connection. Must never be serialized: it carries the
/// plaintext API token.
pub struct JiraConnection {
    pub base_url: String,
    pub email: String,
    pub api_token: String,
    pub enabled: bool,
}

/// Connection state returned to the frontend. Carries no secret.
#[derive(Serialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub base_url: Option<String>,
    pub email: Option<String>,
    pub enabled: bool,
}

#[derive(Deserialize)]
pub struct ConnectInput {
    pub base_url: String,
    pub email: String,
    pub api_token: String,
}

#[derive(Deserialize)]
pub struct ImportInput {
    #[serde(default)]
    pub jql: Option<String>,
    #[serde(default)]
    pub max_results: Option<u32>,
}

// Jira REST response shapes, projecting only the fields we read.

#[derive(Deserialize)]
pub struct JiraSearchResponse {
    #[serde(default)]
    pub issues: Vec<JiraIssue>,
    /// Cursor for the next page. Absent on the last page, so its presence is the
    /// signal to keep paginating.
    #[serde(rename = "nextPageToken", default)]
    pub next_page_token: Option<String>,
}

#[derive(Deserialize)]
pub struct JiraIssue {
    pub key: String,
    pub fields: JiraFields,
}

#[derive(Deserialize)]
pub struct JiraFields {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub description: Option<Value>,
    #[serde(default)]
    pub status: Option<JiraStatus>,
    #[serde(default)]
    pub priority: Option<JiraPriority>,
}

#[derive(Deserialize)]
pub struct JiraStatus {
    #[serde(default)]
    pub name: String,
    #[serde(rename = "statusCategory", default)]
    pub status_category: Option<JiraStatusCategory>,
}

#[derive(Deserialize, Default)]
pub struct JiraStatusCategory {
    #[serde(default)]
    pub key: String,
}

#[derive(Deserialize)]
pub struct JiraPriority {
    #[serde(default)]
    pub name: String,
}

/// The envelope Jira Cloud POSTs to a registered webhook. `issue` is absent for
/// non-issue events.
#[derive(Deserialize)]
pub struct JiraWebhookPayload {
    #[serde(rename = "webhookEvent", default)]
    pub webhook_event: String,
    #[serde(default)]
    pub issue: Option<JiraWebhookIssue>,
}

/// The `issue` object inside a webhook payload. `self`'s host identifies the Jira
/// site, which is how a delivery is matched to the stored `jira_base`.
#[derive(Deserialize)]
pub struct JiraWebhookIssue {
    pub key: String,
    #[serde(rename = "self", default)]
    pub self_url: Option<String>,
    pub fields: JiraFields,
}

#[derive(Deserialize)]
pub struct JiraTransitionsResponse {
    #[serde(default)]
    pub transitions: Vec<JiraTransition>,
}

#[derive(Deserialize)]
pub struct JiraTransition {
    pub id: String,
    #[serde(default)]
    pub to: Option<JiraStatus>,
}
