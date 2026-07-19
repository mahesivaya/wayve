use chrono::{NaiveDate, NaiveTime};
use sqlx::{PgPool, Row};
use thiserror::Error;
use tracing::{info, instrument, warn};

use crate::scheduler::mail_delivery::{
    GmailSender, RawMailSender, build_meeting_content, build_meeting_message, filter_participants,
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
    #[error("No valid participants")]
    NoValidParticipants,
    #[error("HTTP client error: {0}")]
    HttpClient(#[source] reqwest::Error),
    #[error("HTTP send error: {0}")]
    SendRequest(#[source] reqwest::Error),
    #[error("Gmail failed: {0}")]
    GmailStatus(String),
    #[error("SMTP failed: {0}")]
    SmtpFailed(String),
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

    let valid_participants = filter_participants(participants);
    if valid_participants.is_empty() {
        return Err(MeetingEmailError::NoValidParticipants);
    }

    // Prefer the organizer's own Gmail: the invite then comes from their real
    // address and lands in their Sent folder. Only accounts with a usable token
    // qualify — anything else falls through to SMTP rather than failing, which
    // is what silently broke invites for every local-auth (non-Gmail) user.
    let gmail = sqlx::query(
        "SELECT access_token, email FROM email_accounts \
         WHERE user_id = $1 AND is_active = true AND access_token <> '' LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    if let Some(row) = gmail {
        let access_token: String = row.get("access_token");
        let sender_email: String = row.get("email");

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

        match sender.send(&access_token, &message).await {
            Ok(()) => {
                info!(target: "scheduler", user_id, via = "gmail", "meeting emails sent");
                return Ok(());
            }
            // An expired token or a disabled Gmail API shouldn't cost the
            // participant their invite; SMTP is a working second chance.
            Err(e) => {
                warn!(
                    target: "scheduler", user_id, error = %e,
                    "gmail invite send failed; falling back to SMTP"
                );
            }
        }
    }

    send_via_smtp(
        pool,
        user_id,
        &valid_participants,
        &title,
        date,
        start,
        end,
        kind,
        zoom_join_url.as_deref(),
    )
    .await
}

/// SMTP delivery, one message per participant. Sending individually keeps each
/// participant's address off the others' To line, and lets a single bad address
/// fail without taking the rest of the invites with it.
#[allow(clippy::too_many_arguments)]
async fn send_via_smtp(
    pool: &PgPool,
    user_id: i32,
    participants: &[String],
    title: &str,
    date: NaiveDate,
    start: NaiveTime,
    end: NaiveTime,
    kind: MeetingEmailKind,
    zoom_join_url: Option<&str>,
) -> Result<(), MeetingEmailError> {
    let (subject, body) = build_meeting_content(title, date, start, end, kind, zoom_join_url);

    // Mail goes out as the server's SMTP identity, so point replies at the
    // organizer instead — otherwise participants answer a shared mailbox.
    let organizer: Option<String> = sqlx::query("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .map(|r| r.get("email"));

    let mut sent = 0usize;
    let mut last_error: Option<String> = None;
    for to in participants {
        match crate::email::sender::send_mail_reply_to(to, &subject, &body, organizer.as_deref())
            .await
        {
            Ok(()) => sent += 1,
            Err(e) => {
                warn!(target: "scheduler", user_id, to = %to, error = %e, "smtp invite send failed");
                last_error = Some(e.to_string());
            }
        }
    }

    if sent == 0 {
        return Err(MeetingEmailError::SmtpFailed(
            last_error.unwrap_or_else(|| "no participants accepted".to_string()),
        ));
    }

    info!(target: "scheduler", user_id, sent, via = "smtp", "meeting emails sent");
    Ok(())
}
