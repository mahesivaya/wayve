use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use thiserror::Error;
use tracing::instrument;

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
}

#[derive(Deserialize)]
struct MeetingResp {
    join_url: String,
}

#[derive(Debug, Error)]
pub enum ZoomError {
    #[error("{0} not set")]
    MissingEnv(&'static str),
    #[error("HTTP client error: {0}")]
    HttpClient(#[source] reqwest::Error),
    #[error("Zoom token request failed: {0}")]
    TokenRequest(#[source] reqwest::Error),
    #[error("Zoom token error: {0}")]
    TokenStatus(String),
    #[error("Zoom token parse error: {0}")]
    TokenParse(#[source] reqwest::Error),
    #[error("Zoom create request failed: {0}")]
    CreateRequest(#[source] reqwest::Error),
    #[error("Zoom create error: {0}")]
    CreateStatus(String),
    #[error("Zoom meeting parse error: {0}")]
    MeetingParse(#[source] reqwest::Error),
}

pub fn encode_basic_auth(client_id: &str, client_secret: &str) -> String {
    STANDARD.encode(format!("{client_id}:{client_secret}"))
}

pub fn build_meeting_body(topic: &str, start_utc: DateTime<Utc>, duration_min: i64) -> Value {
    json!({
        "topic": topic,
        "type": 2,
        "start_time": start_utc.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        "duration": duration_min,
        "timezone": "UTC",
        "settings": {
            "join_before_host": true,
            "approval_type": 2,
            "waiting_room": false
        }
    })
}

#[async_trait]
pub trait ZoomClient: Send + Sync {
    async fn create_meeting(
        &self,
        topic: &str,
        start_utc: DateTime<Utc>,
        duration_min: i64,
    ) -> Result<String, ZoomError>;
}

pub struct HttpZoomClient;

#[async_trait]
impl ZoomClient for HttpZoomClient {
    async fn create_meeting(
        &self,
        topic: &str,
        start_utc: DateTime<Utc>,
        duration_min: i64,
    ) -> Result<String, ZoomError> {
        let token = fetch_access_token().await?;
        post_create_meeting(&token, topic, start_utc, duration_min).await
    }
}

#[instrument(target = "scheduler")]
async fn fetch_access_token() -> Result<String, ZoomError> {
    let crate::config::ZoomConfig {
        account_id,
        client_id,
        client_secret,
    } = crate::config::zoom().map_err(ZoomError::MissingEnv)?;

    let basic = encode_basic_auth(&client_id, &client_secret);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(ZoomError::HttpClient)?;

    let res = client
        .post(crate::external::zoom_oauth_token_url())
        .header("Authorization", format!("Basic {basic}"))
        .form(&[
            ("grant_type", "account_credentials"),
            ("account_id", account_id.as_str()),
        ])
        .send()
        .await
        .map_err(ZoomError::TokenRequest)?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(ZoomError::TokenStatus(text));
    }

    let tok: TokenResp = res.json().await.map_err(ZoomError::TokenParse)?;
    Ok(tok.access_token)
}

async fn post_create_meeting(
    token: &str,
    topic: &str,
    start_utc: DateTime<Utc>,
    duration_min: i64,
) -> Result<String, ZoomError> {
    let body = build_meeting_body(topic, start_utc, duration_min);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(ZoomError::HttpClient)?;

    let res = client
        .post(format!(
            "{}/v2/users/me/meetings",
            crate::external::zoom_api_base()
        ))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(ZoomError::CreateRequest)?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(ZoomError::CreateStatus(text));
    }

    let m: MeetingResp = res.json().await.map_err(ZoomError::MeetingParse)?;
    Ok(m.join_url)
}

#[instrument(target = "scheduler", skip(start_utc), fields(topic, duration_min))]
pub async fn create_zoom_meeting(
    topic: &str,
    start_utc: DateTime<Utc>,
    duration_min: i64,
) -> Result<String, ZoomError> {
    create_zoom_meeting_with(&HttpZoomClient, topic, start_utc, duration_min).await
}

pub async fn create_zoom_meeting_with(
    client: &dyn ZoomClient,
    topic: &str,
    start_utc: DateTime<Utc>,
    duration_min: i64,
) -> Result<String, ZoomError> {
    client.create_meeting(topic, start_utc, duration_min).await
}
