//! The meeting card on an opened invitation: `GET /api/emails/{id}/invite`.
//!
//! Read from the provider when the email is opened, not stored at sync: the
//! list only needs to know an email is an invitation (`EmailListRow::is_invite`),
//! and the card wants the whole calendar part, which Gmail may carry inline
//! with no file name. Gmail's is parsed from iCalendar (`email::ical`);
//! Outlook's comes structured, from the meeting message's event.

use crate::email::account::open_refresh_token;
use crate::email::attachments::fetch_gmail_attachment_bytes;
use crate::email::ical::{Invite, https_url, parse_invite, video_link, windows_zone};
use crate::email::oauth::HTTP_CLIENT;
use crate::email::provider::{MailProvider, refresh_and_persist_email_token};
use crate::prelude::*;
use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
use tracing::{error, instrument};
use wayve_security::jwt::get_user_id_from_request;

#[actix_web::get("/emails/{id}/invite")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn get_email_invite(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let email_id = path.into_inner();

    // Whoever can open the email can see its invitation: its owner, a
    // shared-inbox member, or the recipient of Fluxze mail.
    let Some(row) = sqlx::query(
        r#"
        SELECT e.gmail_id, e.source, e.account_id, e.thread_id, a.provider, a.refresh_token_iv, a.refresh_token_encrypted
        FROM emails e
        LEFT JOIN email_accounts a ON e.account_id = a.id
        LEFT JOIN shared_inbox_members sm ON sm.account_id = a.id AND sm.user_id = $2
        WHERE e.id = $1
          AND (a.user_id = $2
               OR sm.user_id IS NOT NULL
               OR (e.source = 'wayve' AND e.recipient_user_id = $2))
        "#,
    )
    .bind(email_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    else {
        return Ok(HttpResponse::NotFound().json(serde_json::json!({
            "error": "Email not found"
        })));
    };

    let no_invite = || {
        HttpResponse::NotFound().json(serde_json::json!({
            "error": "No invitation in this email"
        }))
    };
    let source: Option<String> = row.try_get("source").ok().flatten();
    let account_id: Option<i32> = row.try_get("account_id").ok().flatten();
    let provider = row
        .try_get::<Option<String>, _>("provider")
        .ok()
        .flatten()
        .map(|p| MailProvider::from_db(&p));
    // Fluxze mail has no provider copy, and IMAP keeps no source to re-read.
    let (Some(account_id), Some(provider)) = (account_id, provider) else {
        return Ok(no_invite());
    };
    if source.as_deref() == Some("wayve") || provider == MailProvider::Imap {
        return Ok(no_invite());
    }

    let refresh_token = open_refresh_token(&row);
    let Some(refresh_token) = refresh_token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    else {
        // 409, not 401: the session is fine, the mailbox needs reconnecting.
        return Ok(HttpResponse::Conflict().json(serde_json::json!({
            "error": "Reconnect your email account to see this invitation"
        })));
    };
    let token = match refresh_and_persist_email_token(
        pool.get_ref(),
        account_id,
        provider,
        refresh_token,
    )
    .await
    {
        Ok(token) => token.access_token,
        Err(e) => {
            error!(target: "gmail", user_id, account_id, error = ?e, "invite token refresh failed");
            return Ok(HttpResponse::BadGateway().json(serde_json::json!({
                "error": "Failed to refresh email account credentials"
            })));
        }
    };

    let thread_id: Option<i32> = row.try_get("thread_id").ok().flatten();
    let message_id = invitation_message_id(pool.get_ref(), email_id, account_id, thread_id)
        .await?
        .unwrap_or_else(|| row.get("gmail_id"));
    let invite = if provider.is_microsoft() {
        outlook_invite(&token, &message_id).await
    } else {
        gmail_invite(&token, &message_id).await
    };
    match invite {
        Ok(Some(invite)) => Ok(HttpResponse::Ok().json(invite)),
        Ok(None) => Ok(no_invite()),
        Err(e) => {
            error!(target: "gmail", user_id, account_id, email_id, error = ?e, "reading invite failed");
            Ok(HttpResponse::BadGateway().json(serde_json::json!({
                "error": "Couldn't read the invitation from your email provider"
            })))
        }
    }
}

/// Which message's invitation the card shows: this email if it carries one,
/// else the newest one in its conversation that does. The list marks a
/// conversation when any message is an invitation (`is_invite`), and the
/// email opened is its newest, which may be a reply with no calendar part.
/// `None` when no message is known to carry one: the caller then reads this
/// email anyway, as Gmail may hold a calendar part the list never saw.
pub async fn invitation_message_id(
    pool: &PgPool,
    email_id: i32,
    account_id: i32,
    thread_id: Option<i32>,
) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(
        r#"
        SELECT c.gmail_id
        FROM emails c
        WHERE c.account_id = $2
          AND (c.id = $1 OR ($3::int IS NOT NULL AND c.thread_id = $3))
          AND NOT ('TRASH' = ANY(c.labels))
          AND (EXISTS (
                  SELECT 1 FROM email_attachments ia
                  WHERE ia.email_id = c.id
                    AND (ia.mime_type ILIKE 'text/calendar%' OR ia.filename ILIKE '%.ics')
               ) OR 'WAYVE_INVITE' = ANY(c.labels))
        ORDER BY (c.id = $1) DESC, c.created_at DESC, c.id DESC
        LIMIT 1
        "#,
    )
    .bind(email_id)
    .bind(account_id)
    .bind(thread_id)
    .fetch_optional(pool)
    .await
}

/// The message's calendar part: a `text/calendar` part first (the one calendar
/// apps send for the client to read), else an attached `.ics`.
fn find_calendar_part(payload: &Value) -> Option<&Value> {
    fn find<'a>(part: &'a Value, matches: &dyn Fn(&Value) -> bool) -> Option<&'a Value> {
        if matches(part) {
            return Some(part);
        }
        part["parts"]
            .as_array()?
            .iter()
            .find_map(|child| find(child, matches))
    }
    find(payload, &|p| {
        p["mimeType"]
            .as_str()
            .is_some_and(|m| m.to_ascii_lowercase().starts_with("text/calendar"))
    })
    .or_else(|| {
        find(payload, &|p| {
            p["filename"]
                .as_str()
                .is_some_and(|f| f.to_ascii_lowercase().ends_with(".ics"))
                || p["mimeType"].as_str() == Some("application/ics")
        })
    })
}

/// `method=REQUEST` on the part's Content-Type, for a calendar body without a
/// METHOD line of its own.
fn content_type_method(part: &Value) -> Option<String> {
    let content_type = part["headers"].as_array()?.iter().find_map(|h| {
        h["name"]
            .as_str()
            .filter(|n| n.eq_ignore_ascii_case("Content-Type"))
            .and(h["value"].as_str())
    })?;
    content_type.split(';').find_map(|param| {
        let (k, v) = param.split_once('=')?;
        k.trim()
            .eq_ignore_ascii_case("method")
            .then(|| v.trim().trim_matches('"').to_ascii_lowercase())
    })
}

/// A Gmail message's invitation, read from its calendar part, whether that is
/// inline (`body.data`) or attached (`body.attachmentId`).
pub async fn gmail_invite(token: &str, message_id: &str) -> anyhow::Result<Option<Invite>> {
    let message: Value = HTTP_CLIENT
        .get(format!(
            "{}/gmail/v1/users/me/messages/{message_id}?format=full",
            crate::external::gmail_api_base()
        ))
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let Some(part) = find_calendar_part(&message["payload"]) else {
        return Ok(None);
    };
    let text = if let Some(data) = part["body"]["data"].as_str() {
        // base64url, with or without padding: read it either way, as for
        // attachments (the shared body decoder wants padding).
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(data.trim_end_matches('='))
            .map_err(|e| anyhow::anyhow!("calendar part base64 decode failed: {e}"))?;
        String::from_utf8_lossy(&bytes).into_owned()
    } else if let Some(attachment_id) = part["body"]["attachmentId"].as_str() {
        let bytes = fetch_gmail_attachment_bytes(token, message_id, attachment_id).await?;
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        return Ok(None);
    };
    let mut invite = parse_invite(&text);
    if let Some(invite) = invite.as_mut()
        && invite.method.is_none()
    {
        invite.method = content_type_method(part);
    }
    Ok(invite)
}

/// An Outlook meeting message's invitation: the message with its event.
pub async fn outlook_invite(token: &str, message_id: &str) -> anyhow::Result<Option<Invite>> {
    let mut url = reqwest::Url::parse(&format!(
        "{}/v1.0/me/messages",
        crate::external::microsoft_graph_base()
    ))?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Graph base must be a base URL"))?
        .push(message_id);
    url.query_pairs_mut()
        .append_pair("$expand", "microsoft.graph.eventMessage/event");
    let message: Value = HTTP_CLIENT
        .get(url)
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(outlook_event_invite(&message))
}

/// Graph's `{ dateTime, timeZone }`, which is UTC unless asked otherwise.
fn graph_time(value: &Value) -> (Option<chrono::DateTime<Utc>>, Option<NaiveDateTime>) {
    let Some(text) = value["dateTime"].as_str() else {
        return (None, None);
    };
    // Graph writes seven fractional digits; seconds are plenty here.
    let whole = text.split('.').next().unwrap_or(text);
    let Ok(local) = NaiveDateTime::parse_from_str(whole, "%Y-%m-%dT%H:%M:%S") else {
        return (None, None);
    };
    let zone = value["timeZone"].as_str().unwrap_or("UTC");
    let tz = zone
        .parse::<chrono_tz::Tz>()
        .ok()
        .or_else(|| windows_zone(zone).and_then(|iana| iana.parse().ok()));
    match tz {
        Some(tz) => (
            tz.from_local_datetime(&local)
                .earliest()
                .map(|t| t.with_timezone(&Utc)),
            None,
        ),
        None => (None, Some(local)),
    }
}

/// The invite card from a Graph message with its expanded event. `None` for a
/// message that isn't a meeting message.
pub fn outlook_event_invite(message: &Value) -> Option<Invite> {
    let event = message.get("event").filter(|e| e.is_object())?;
    let method = message["meetingMessageType"].as_str().map(|t| {
        match t {
            "meetingRequest" => "request",
            "meetingCancelled" => "cancel",
            "meetingAccepted"
            | "meetingTenativelyAccepted"
            | "meetingTentativelyAccepted"
            | "meetingDeclined" => "reply",
            other => other,
        }
        .to_string()
    });
    let mut invite = Invite {
        method,
        title: event["subject"]
            .as_str()
            .or(message["subject"].as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty()),
        all_day: event["isAllDay"].as_bool().unwrap_or(false),
        location: event["location"]["displayName"]
            .as_str()
            .map(str::to_string)
            .filter(|s| !s.is_empty()),
        organizer_name: event["organizer"]["emailAddress"]["name"]
            .as_str()
            .map(str::to_string),
        organizer_email: event["organizer"]["emailAddress"]["address"]
            .as_str()
            .map(str::to_string),
        status: event["isCancelled"]
            .as_bool()
            .filter(|cancelled| *cancelled)
            .map(|_| "cancelled".to_string()),
        ..Invite::default()
    };
    if invite.all_day {
        let date = |v: &Value| {
            v["dateTime"]
                .as_str()
                .and_then(|t| NaiveDate::parse_from_str(t.get(..10)?, "%Y-%m-%d").ok())
        };
        invite.start_date = date(&event["start"]);
        invite.end_date = date(&event["end"]);
    } else {
        (invite.start, invite.start_local) = graph_time(&event["start"]);
        (invite.end, invite.end_local) = graph_time(&event["end"]);
        if invite.start_local.is_some() {
            invite.time_zone = event["start"]["timeZone"].as_str().map(str::to_string);
        }
    }
    // https only, as for Gmail (`ical::https_url`): the event is the sender's.
    invite.join_url = event["onlineMeeting"]["joinUrl"]
        .as_str()
        .and_then(https_url)
        .or_else(|| event["onlineMeetingUrl"].as_str().and_then(https_url))
        .or_else(|| invite.location.as_deref().and_then(video_link));
    Some(invite)
}
