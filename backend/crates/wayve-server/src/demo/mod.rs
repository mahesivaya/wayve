//! Public "Book a demo" lead capture.
//!
//! Reached from the marketing home page (`/book-demo`). Anonymous — no auth.
//! Each submission is persisted to `demo_requests`, then emailed to sales with
//! an `.ics` invite so the chosen slot lands on a calendar.

use crate::email::sender::send_mail_with_ics;
use crate::prelude::*;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use tracing::{error, info};

/// Default length of the booked slot.
const DEMO_DURATION_MINUTES: i64 = 30;

#[derive(Deserialize)]
pub struct DemoRequestInput {
    pub first_name: String,
    pub last_name: String,
    pub email: String,
    pub work_email: String,
    /// RFC3339 instant — the visitor's local choice, serialized as UTC.
    pub scheduled_at: String,
}

pub async fn create_demo_request(
    pool: web::Data<PgPool>,
    data: web::Json<DemoRequestInput>,
) -> AppResult {
    let first = data.first_name.trim();
    let last = data.last_name.trim();
    let email = data.email.trim().to_lowercase();
    let work_email = data.work_email.trim().to_lowercase();

    if first.is_empty() || last.is_empty() || email.is_empty() || work_email.is_empty() {
        return Err(AppError::BadRequest("All fields are required.".into()));
    }
    if !valid_email(&email) || !valid_email(&work_email) {
        return Err(AppError::BadRequest(
            "Please provide valid email addresses.".into(),
        ));
    }
    let scheduled_at = DateTime::parse_from_rfc3339(data.scheduled_at.trim())
        .map_err(|_| AppError::BadRequest("Invalid date/time.".into()))?
        .with_timezone(&Utc);

    // Persist first so a mail failure never loses the lead.
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO demo_requests (first_name, last_name, email, work_email, scheduled_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id",
    )
    .bind(first)
    .bind(last)
    .bind(&email)
    .bind(&work_email)
    .bind(scheduled_at)
    .fetch_one(pool.get_ref())
    .await?;

    info!(target: "demo", demo_request_id = id, "demo request stored");

    // Email sales with an .ics so the slot drops onto their calendar. Best
    // effort: a send failure is logged, the stored lead still succeeds. The
    // recipient (and calendar organizer) is configurable via DEMO_NOTIFY_EMAIL.
    let notify = crate::config::demo_notify_email();
    let ics = build_ics(id, first, last, &email, &work_email, scheduled_at, &notify);
    let when = scheduled_at.to_rfc3339_opts(SecondsFormat::Secs, true);
    let subject = format!("New demo request — {first} {last}");
    let body = format!(
        "A new demo was booked on fluxze.com.\n\n\
         Name:        {first} {last}\n\
         Email:       {email}\n\
         Work email:  {work_email}\n\
         Requested:   {when} (UTC)\n\n\
         The attached invite (invite.ics) adds this to your calendar."
    );

    let emailed = match send_mail_with_ics(&notify, &subject, &body, &ics).await {
        Ok(()) => true,
        Err(e) => {
            error!(target: "demo", demo_request_id = id, error = %e, "demo request email failed");
            false
        }
    };
    if emailed
        && let Err(e) = sqlx::query("UPDATE demo_requests SET emailed = TRUE WHERE id = $1")
            .bind(id)
            .execute(pool.get_ref())
            .await
    {
        error!(target: "demo", demo_request_id = id, error = %e, "demo request emailed-flag update failed");
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "id": id,
        "scheduled_at": scheduled_at.to_rfc3339(),
        "emailed": emailed,
    })))
}

/// Minimal email shape check — one `@`, a non-empty local part, and a dotted
/// domain that doesn't start or end with a dot.
fn valid_email(value: &str) -> bool {
    match value.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        }
        None => false,
    }
}

/// Escape a value for inclusion in an iCalendar text field (RFC 5545 §3.3.11).
fn escape_ics(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

/// Build a single-event VCALENDAR (METHOD:REQUEST) for the booked slot.
#[allow(clippy::too_many_arguments)]
fn build_ics(
    id: i32,
    first: &str,
    last: &str,
    email: &str,
    work_email: &str,
    start: DateTime<Utc>,
    organizer: &str,
) -> String {
    let end = start + Duration::minutes(DEMO_DURATION_MINUTES);
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ");
    let dtstart = start.format("%Y%m%dT%H%M%SZ");
    let dtend = end.format("%Y%m%dT%H%M%SZ");
    let name = format!("{first} {last}");
    let summary = escape_ics(&format!("Fluxze demo with {name}"));
    let description = escape_ics(&format!(
        "Demo request via fluxze.com\nName: {name}\nEmail: {email}\nWork email: {work_email}"
    ));
    let attendee_cn = escape_ics(&name);

    [
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".to_string(),
        "PRODID:-//Fluxze//Book a Demo//EN".to_string(),
        "CALSCALE:GREGORIAN".to_string(),
        "METHOD:REQUEST".to_string(),
        "BEGIN:VEVENT".to_string(),
        format!("UID:demo-{id}@fluxze.com"),
        format!("DTSTAMP:{stamp}"),
        format!("DTSTART:{dtstart}"),
        format!("DTEND:{dtend}"),
        format!("SUMMARY:{summary}"),
        format!("DESCRIPTION:{description}"),
        format!("ORGANIZER;CN=Fluxze Sales:mailto:{organizer}"),
        format!("ATTENDEE;CN={attendee_cn};RSVP=TRUE:mailto:{work_email}"),
        "LOCATION:Online".to_string(),
        "STATUS:CONFIRMED".to_string(),
        "SEQUENCE:0".to_string(),
        "END:VEVENT".to_string(),
        "END:VCALENDAR".to_string(),
    ]
    .join("\r\n")
}

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/demo-requests", web::post().to(create_demo_request));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_email_shapes() {
        assert!(valid_email("a@b.com"));
        assert!(valid_email("ada.lovelace@example.co.uk"));
        assert!(!valid_email("no-at-sign"));
        assert!(!valid_email("@example.com"));
        assert!(!valid_email("a@nodot"));
        assert!(!valid_email("a@.com"));
        assert!(!valid_email("a@com."));
    }

    #[test]
    fn ics_has_event_at_chosen_time() {
        let start = DateTime::parse_from_rfc3339("2026-06-25T14:30:00Z")
            .unwrap_or_else(|e| panic!("parse: {e}"))
            .with_timezone(&Utc);
        let ics = build_ics(
            42,
            "Ada",
            "Lovelace",
            "ada@x.com",
            "ada@work.com",
            start,
            "sales@fluxze.com",
        );

        assert!(ics.contains("BEGIN:VEVENT"));
        assert!(ics.contains("UID:demo-42@fluxze.com"));
        assert!(ics.contains("DTSTART:20260625T143000Z"));
        // 30 minutes later.
        assert!(ics.contains("DTEND:20260625T150000Z"));
        assert!(ics.contains("SUMMARY:Fluxze demo with Ada Lovelace"));
        assert!(ics.contains("ORGANIZER;CN=Fluxze Sales:mailto:sales@fluxze.com"));
        assert!(ics.contains("mailto:ada@work.com"));
        assert!(ics.contains("\r\n"));
    }

    #[test]
    fn ics_escapes_special_chars() {
        let start = DateTime::parse_from_rfc3339("2026-06-25T14:30:00Z")
            .unwrap_or_else(|e| panic!("parse: {e}"))
            .with_timezone(&Utc);
        // Comma in the name must be escaped in the SUMMARY line.
        let ics = build_ics(
            1,
            "Ada,",
            "Lovelace",
            "a@x.com",
            "a@y.com",
            start,
            "sales@fluxze.com",
        );
        assert!(ics.contains("Ada\\,"));
    }
}
