use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{NaiveDate, NaiveTime};
use serde_json::json;
use sqlx::{PgPool, Row};
use thiserror::Error;
use tracing::{info, instrument};

#[derive(Clone, Copy)]
pub enum MeetingEmailKind {
    Invite,
    Update,
    Cancel,
}

pub struct MeetingEmailRequest {
    pub user_id: i32,
    pub participants: Vec<String>,
    pub title: String,
    pub date: NaiveDate,
    pub start: NaiveTime,
    pub end: NaiveTime,
    pub kind: MeetingEmailKind,
    pub zoom_join_url: Option<String>,
}

#[derive(Debug, Error)]
pub enum MeetingEmailError {
    #[error("DB error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("No active Gmail account found")]
    NoActiveAccount,
    #[error("Missing access token")]
    MissingAccessToken,
    #[error("No valid participants")]
    NoValidParticipants,
    #[error("HTTP client error: {0}")]
    HttpClient(#[source] reqwest::Error),
    #[error("HTTP send error: {0}")]
    SendRequest(#[source] reqwest::Error),
    #[error("Gmail failed: {0}")]
    GmailStatus(String),
}

#[instrument(
    target = "scheduler",
    skip(pool, req),
    fields(user_id = req.user_id, participant_count = req.participants.len())
)]
pub async fn send_meeting_emails(
    pool: &PgPool,
    req: MeetingEmailRequest,
) -> Result<(), MeetingEmailError> {
    let MeetingEmailRequest {
        user_id,
        participants,
        title,
        date,
        start,
        end,
        kind,
        zoom_join_url,
    } = req;

    let row = sqlx::query(
        "SELECT access_token, email FROM email_accounts 
         WHERE user_id = $1 AND is_active = true LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    let row = match row {
        Some(r) => r,
        None => return Err(MeetingEmailError::NoActiveAccount),
    };

    let access_token: String = row.get("access_token");
    let sender_email: String = row.get("email");

    if access_token.is_empty() {
        return Err(MeetingEmailError::MissingAccessToken);
    }

    let valid_participants: Vec<String> = participants
        .into_iter()
        .map(|e| e.trim().to_lowercase())
        .filter(|e| e.contains("@") && e.contains("."))
        .collect();

    if valid_participants.is_empty() {
        return Err(MeetingEmailError::NoValidParticipants);
    }

    let start_str = start.format("%H:%M").to_string();
    let end_str = end.format("%H:%M").to_string();

    let (header, subject_prefix) = match kind {
        MeetingEmailKind::Invite => ("📅 Meeting Invitation", "Meeting"),
        MeetingEmailKind::Update => ("✏️ Meeting Updated", "Updated"),
        MeetingEmailKind::Cancel => ("❌ Meeting Cancelled", "Cancelled"),
    };

    let zoom_line = match &zoom_join_url {
        Some(url) if !url.is_empty() => format!("\nZoom: {}", url),
        _ => String::new(),
    };

    let body = format!(
        "{}\n\nTitle: {}\nDate: {}\nStart: {}\nEnd: {}{}\n\n-- Wayve Scheduler",
        header, title, date, start_str, end_str, zoom_line
    );

    let to_list = valid_participants.join(",");

    let raw_message = format!(
        "From: {}\r\n\
To: {}\r\n\
Subject: {}: {}\r\n\
Content-Type: text/plain; charset=\"UTF-8\"\r\n\r\n{}",
        sender_email, to_list, subject_prefix, title, body
    );

    let encoded = URL_SAFE_NO_PAD.encode(raw_message);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(MeetingEmailError::HttpClient)?;

    let res = client
        .post(crate::external::gmail_send_url())
        .bearer_auth(access_token)
        .json(&json!({ "raw": encoded }))
        .send()
        .await
        .map_err(MeetingEmailError::SendRequest)?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(MeetingEmailError::GmailStatus(text));
    }

    info!(target: "scheduler", user_id, "meeting emails sent");

    Ok(())
}
