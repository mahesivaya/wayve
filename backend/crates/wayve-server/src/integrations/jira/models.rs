use crate::prelude::*;

/// A decrypted per-user Jira connection, ready to make authenticated calls.
/// Never serialized — it carries the plaintext API token.
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

// ---- Jira REST response shapes (only the fields we read) ----

#[derive(Deserialize)]
pub struct JiraSearchResponse {
    #[serde(default)]
    pub issues: Vec<JiraIssue>,
    /// Cursor for the next page of the enhanced JQL search. Absent on the last
    /// page; its presence is the signal to keep paginating.
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

// ---- Inbound webhook payload (only the fields we read) ----

/// The envelope Jira Cloud POSTs to a registered webhook. `webhook_event` is
/// e.g. `jira:issue_updated`; `issue` is absent for non-issue events.
#[derive(Deserialize)]
pub struct JiraWebhookPayload {
    #[serde(rename = "webhookEvent", default)]
    pub webhook_event: String,
    #[serde(default)]
    pub issue: Option<JiraWebhookIssue>,
}

/// The `issue` object inside a webhook payload. Reuses `JiraFields` (same shape
/// as the REST search response) and adds `self`, whose host identifies the Jira
/// site so we can match the stored `jira_base`.
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
