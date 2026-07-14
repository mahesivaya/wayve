//! Thin Jira Cloud REST client: the shared `HTTP_CLIENT`, a per-connection base
//! URL (overridable for tests via `external::jira_api_base`), and Basic auth from
//! the connection's email and API token. There is no `BadGateway` variant, so
//! transport errors and non-2xx render as 500, while 401 and 403 surface as
//! `AppError::Unauthorized`.

use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::de::DeserializeOwned;
use std::time::Duration;
use tracing::warn;

use super::models::{
    JiraConnection, JiraIssue, JiraSearchResponse, JiraTransition, JiraTransitionsResponse,
};

pub struct JiraClient {
    base: String,
    auth: String,
}

impl JiraClient {
    pub fn new(conn: &JiraConnection) -> Self {
        let base = crate::external::jira_api_base(&conn.base_url);
        let auth = format!(
            "Basic {}",
            STANDARD.encode(format!("{}:{}", conn.email, conn.api_token))
        );
        Self { base, auth }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/rest/api/3{}", self.base.trim_end_matches('/'), path)
    }

    fn check_status(&self, status: reqwest::StatusCode) -> Result<(), AppError> {
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(AppError::Unauthorized);
        }
        if !status.is_success() {
            warn!(target: "worker", status = status.as_u16(), "jira request non-2xx");
            return Err(AppError::Internal(format!(
                "Jira returned status {}",
                status.as_u16()
            )));
        }
        Ok(())
    }

    async fn send(&self, builder: reqwest::RequestBuilder) -> Result<reqwest::Response, AppError> {
        let resp = builder
            .timeout(Duration::from_secs(20))
            .header("Authorization", &self.auth)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| {
                warn!(target: "worker", error = ?e, "jira request transport error");
                AppError::Internal("Jira upstream call failed".into())
            })?;
        self.check_status(resp.status())?;
        Ok(resp)
    }

    async fn send_json<T: DeserializeOwned>(
        &self,
        builder: reqwest::RequestBuilder,
    ) -> Result<T, AppError> {
        let resp = self.send(builder).await?;
        resp.json::<T>().await.map_err(|e| {
            warn!(target: "worker", error = ?e, "jira response decode error");
            AppError::Internal("Jira response decode failed".into())
        })
    }

    /// Validate the credentials: 401 or 403 means they are bad.
    pub async fn test_connection(&self) -> Result<(), AppError> {
        let url = self.url("/myself");
        let _: Value = self.send_json(HTTP_CLIENT.get(&url)).await?;
        Ok(())
    }

    /// Uses the enhanced-search endpoint that replaced the removed `/search` on
    /// Jira Cloud, and follows `nextPageToken` because Jira caps a page at 100. The
    /// 20-page backstop guards against a runaway loop.
    pub async fn search(&self, jql: &str, max_results: u32) -> Result<Vec<JiraIssue>, AppError> {
        let url = self.url("/search/jql");
        let mut all: Vec<JiraIssue> = Vec::new();
        let mut token: Option<String> = None;

        for _ in 0..20 {
            let remaining = max_results.saturating_sub(all.len() as u32);
            if remaining == 0 {
                break;
            }
            let page_size = remaining.clamp(1, 100).to_string();
            let mut query: Vec<(&str, String)> = vec![
                ("jql", jql.to_string()),
                ("maxResults", page_size),
                ("fields", "summary,description,status,priority".to_string()),
            ];
            if let Some(t) = &token {
                query.push(("nextPageToken", t.clone()));
            }

            let resp: JiraSearchResponse =
                self.send_json(HTTP_CLIENT.get(&url).query(&query)).await?;
            let next = resp.next_page_token.clone();
            all.extend(resp.issues);

            if next.is_none() || all.len() as u32 >= max_results {
                break;
            }
            token = next;
        }

        all.truncate(max_results as usize);
        Ok(all)
    }

    pub async fn list_transitions(&self, key: &str) -> Result<Vec<JiraTransition>, AppError> {
        let url = self.url(&format!("/issue/{key}/transitions"));
        let resp: JiraTransitionsResponse = self.send_json(HTTP_CLIENT.get(&url)).await?;
        Ok(resp.transitions)
    }

    pub async fn transition_issue(&self, key: &str, transition_id: &str) -> Result<(), AppError> {
        let url = self.url(&format!("/issue/{key}/transitions"));
        self.send(
            HTTP_CLIENT
                .post(&url)
                .json(&serde_json::json!({ "transition": { "id": transition_id } })),
        )
        .await?;
        Ok(())
    }

    pub async fn update_summary(&self, key: &str, summary: &str) -> Result<(), AppError> {
        let url = self.url(&format!("/issue/{key}"));
        self.send(
            HTTP_CLIENT
                .put(&url)
                .json(&serde_json::json!({ "fields": { "summary": summary } })),
        )
        .await?;
        Ok(())
    }
}
