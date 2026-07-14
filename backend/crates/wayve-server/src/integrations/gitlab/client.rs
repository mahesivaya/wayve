//! Thin GitLab REST client, mirroring the Jira client: the shared `HTTP_CLIENT`, a
//! per-connection base URL (overridable for tests via `external::gitlab_api_base`),
//! and PAT auth via the `PRIVATE-TOKEN` header. 401 and 403 surface as
//! `AppError::Unauthorized`, other non-2xx as `Internal`.

use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use serde::de::DeserializeOwned;
use std::time::Duration;
use tracing::warn;

use super::models::{GitlabConnection, GitlabIssue};

pub struct GitlabClient {
    base: String,
    token: String,
}

impl GitlabClient {
    pub fn new(conn: &GitlabConnection) -> Self {
        Self {
            base: crate::external::gitlab_api_base(&conn.base_url),
            token: conn.access_token.clone(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/api/v4{}", self.base.trim_end_matches('/'), path)
    }

    fn check_status(&self, status: reqwest::StatusCode) -> Result<(), AppError> {
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(AppError::Unauthorized);
        }
        if !status.is_success() {
            warn!(target: "worker", status = status.as_u16(), "gitlab request non-2xx");
            return Err(AppError::Internal(format!(
                "GitLab returned status {}",
                status.as_u16()
            )));
        }
        Ok(())
    }

    async fn send_json<T: DeserializeOwned>(
        &self,
        builder: reqwest::RequestBuilder,
    ) -> Result<T, AppError> {
        let resp = builder
            .timeout(Duration::from_secs(20))
            .header("PRIVATE-TOKEN", &self.token)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| {
                warn!(target: "worker", error = ?e, "gitlab request transport error");
                AppError::Internal("GitLab upstream call failed".into())
            })?;
        self.check_status(resp.status())?;
        resp.json::<T>().await.map_err(|e| {
            warn!(target: "worker", error = ?e, "gitlab response decode error");
            AppError::Internal("GitLab response decode failed".into())
        })
    }

    /// Validate the token: 401 or 403 means it is bad.
    pub async fn test_connection(&self) -> Result<(), AppError> {
        let _: Value = self.send_json(HTTP_CLIENT.get(self.url("/user"))).await?;
        Ok(())
    }

    /// GitLab caps a page at 100, so this follows page-number pagination, with a
    /// 20-page backstop against a runaway loop.
    pub async fn list_assigned_issues(
        &self,
        state: &str,
        max_results: u32,
    ) -> Result<Vec<GitlabIssue>, AppError> {
        let url = self.url("/issues");
        let mut all: Vec<GitlabIssue> = Vec::new();

        for page in 1..=20u32 {
            let remaining = max_results.saturating_sub(all.len() as u32);
            if remaining == 0 {
                break;
            }
            let per_page = remaining.clamp(1, 100).to_string();
            let query: Vec<(&str, String)> = vec![
                ("scope", "assigned_to_me".to_string()),
                ("state", state.to_string()),
                ("per_page", per_page),
                ("page", page.to_string()),
                ("order_by", "updated_at".to_string()),
            ];

            let page_issues: Vec<GitlabIssue> =
                self.send_json(HTTP_CLIENT.get(&url).query(&query)).await?;
            let got = page_issues.len();
            all.extend(page_issues);

            // A short or empty page means there is nothing more to fetch.
            if got < 100 || all.len() as u32 >= max_results {
                break;
            }
        }

        all.truncate(max_results as usize);
        Ok(all)
    }
}
