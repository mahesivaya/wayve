use chrono::{NaiveDate, NaiveTime};
use sqlx::{PgPool, Row};
use thiserror::Error;
use tracing::{info, instrument};

use crate::scheduler::mail_delivery::{
    GmailSender, RawMailSender, build_meeting_message, filter_participants,
};

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
    send_meeting_emails_with(pool, &GmailSender, req).await
}

pub async fn send_meeting_emails_with(
    pool: &PgPool,
    sender: &dyn RawMailSender,
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
        "SELECT access_token, email FROM email_accounts \
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

    let valid_participants = filter_participants(participants);
    if valid_participants.is_empty() {
        return Err(MeetingEmailError::NoValidParticipants);
    }

    let message = build_meeting_message(
        &sender_email,
        &valid_participants,
        &title,
        date,
        start,
        end,
        kind,
        zoom_join_url.as_deref(),
    );

    sender.send(&access_token, &message).await?;

    info!(target: "scheduler", user_id, "meeting emails sent");

    Ok(())
}
