use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{NaiveDate, NaiveTime};
use serde_json::json;

use crate::scheduler::email_notifications::{MeetingEmailError, MeetingEmailKind};

pub struct RawMailMessage {
    pub raw_b64: String,
}

#[async_trait]
pub trait RawMailSender: Send + Sync {
    async fn send(
        &self,
        access_token: &str,
        message: &RawMailMessage,
    ) -> Result<(), MeetingEmailError>;
}

pub struct GmailSender;

#[async_trait]
impl RawMailSender for GmailSender {
    async fn send(
        &self,
        access_token: &str,
        message: &RawMailMessage,
    ) -> Result<(), MeetingEmailError> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(MeetingEmailError::HttpClient)?;

        let res = client
            .post(crate::external::gmail_send_url())
            .bearer_auth(access_token)
            .json(&json!({ "raw": message.raw_b64 }))
            .send()
            .await
            .map_err(MeetingEmailError::SendRequest)?;

        if !res.status().is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(MeetingEmailError::GmailStatus(text));
        }

        Ok(())
    }
}

pub fn filter_participants(participants: Vec<String>) -> Vec<String> {
    participants
        .into_iter()
        .map(|e| e.trim().to_lowercase())
        .filter(|e| e.contains('@') && e.contains('.'))
        .collect()
}

/// The subject and plain-text body of a meeting email. Shared by both
/// transports so a Gmail-sent invite and an SMTP-sent one are byte-identical —
/// the delivery mechanism must not change what the participant reads.
#[allow(clippy::too_many_arguments)]
pub fn build_meeting_content(
    title: &str,
    date: NaiveDate,
    start: NaiveTime,
    end: NaiveTime,
    kind: MeetingEmailKind,
    zoom_join_url: Option<&str>,
) -> (String, String) {
    let start_str = start.format("%H:%M").to_string();
    let end_str = end.format("%H:%M").to_string();

    let (header, subject_prefix) = match kind {
        MeetingEmailKind::Invite => ("\u{1F4C5} Meeting Invitation", "Meeting"),
        MeetingEmailKind::Update => ("\u{270F}\u{FE0F} Meeting Updated", "Updated"),
        MeetingEmailKind::Cancel => ("\u{274C} Meeting Cancelled", "Cancelled"),
    };

    let zoom_line = match zoom_join_url {
        Some(url) if !url.is_empty() => format!("\nZoom: {url}"),
        _ => String::new(),
    };

    let body = format!(
        "{header}\n\nTitle: {title}\nDate: {date}\nStart: {start_str}\nEnd: {end_str}{zoom_line}\n\n-- Wayve Scheduler"
    );

    (format!("{subject_prefix}: {title}"), body)
}

#[allow(clippy::too_many_arguments)]
pub fn build_meeting_message(
    sender_email: &str,
    participants: &[String],
    title: &str,
    date: NaiveDate,
    start: NaiveTime,
    end: NaiveTime,
    kind: MeetingEmailKind,
    zoom_join_url: Option<&str>,
) -> RawMailMessage {
    let (subject, body) = build_meeting_content(title, date, start, end, kind, zoom_join_url);
    let to_list = participants.join(",");

    let raw_message = format!(
        "From: {sender_email}\r\n\
To: {to_list}\r\n\
Subject: {subject}\r\n\
Content-Type: text/plain; charset=\"UTF-8\"\r\n\r\n{body}"
    );

    RawMailMessage {
        raw_b64: URL_SAFE_NO_PAD.encode(raw_message),
    }
}

#[cfg(test)]
pub fn decode_raw_message(message: &RawMailMessage) -> String {
    let bytes = URL_SAFE_NO_PAD.decode(&message.raw_b64).unwrap_or_default();
    String::from_utf8(bytes).unwrap_or_default()
}
