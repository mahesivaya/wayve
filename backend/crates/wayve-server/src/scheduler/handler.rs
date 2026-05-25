use crate::models::scheduler::{CreateMeeting, Meeting};
use crate::prelude::*;
use crate::scheduler::auth::get_user_id;
use crate::scheduler::email_notifications::{
    MeetingEmailKind, MeetingEmailRequest, send_meeting_emails,
};
use crate::scheduler::time::minutes_to_time;
use crate::scheduler::zoom::create_zoom_meeting;
use wayve_security::encryption::{decrypt, encrypt};
use actix_web::{HttpRequest, HttpResponse, delete, post, put, web};
use chrono::{TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::json;
use std::collections::HashMap;
use std::str::FromStr;
use tracing::{info, instrument, warn};

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use sqlx::{PgPool, Row};

fn decrypt_text_field(
    iv: Option<String>,
    encrypted: Option<String>,
    legacy_plaintext: Option<String>,
) -> String {
    match (iv, encrypted) {
        (Some(iv), Some(encrypted)) if !iv.is_empty() && !encrypted.is_empty() => {
            decrypt(&iv, &encrypted).unwrap_or_else(|_| "[decryption failed]".to_string())
        }
        _ => legacy_plaintext.unwrap_or_default(),
    }
}

fn decrypt_optional_text_field(
    iv: Option<String>,
    encrypted: Option<String>,
    legacy_plaintext: Option<String>,
) -> Option<String> {
    match (iv, encrypted) {
        (Some(iv), Some(encrypted)) if !iv.is_empty() && !encrypted.is_empty() => {
            Some(decrypt(&iv, &encrypted).unwrap_or_else(|_| "[decryption failed]".to_string()))
        }
        _ => legacy_plaintext.filter(|value| !value.is_empty()),
    }
}

fn encrypt_required_field(value: &str) -> Result<(String, String), AppError> {
    encrypt(value).map_err(|e| AppError::Internal(format!("scheduler field encrypt failed: {e}")))
}

fn encrypt_optional_field(
    value: Option<&str>,
) -> Result<(Option<String>, Option<String>), AppError> {
    match value.filter(|value| !value.is_empty()) {
        Some(value) => encrypt(value)
            .map(|(iv, encrypted)| (Some(iv), Some(encrypted)))
            .map_err(|e| {
                AppError::Internal(format!("scheduler optional field encrypt failed: {e}"))
            }),
        None => Ok((None, None)),
    }
}

// ================= CREATE MEETING =================

#[derive(Serialize)]
struct MeetingResponse {
    message: String,
    meeting_id: i32,
}

#[post("/meetings")]
#[instrument(target = "scheduler", skip(req, pool, data), fields(title = %data.title))]
pub async fn create_meeting(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<CreateMeeting>,
) -> AppResult {
    // ================= AUTH =================
    let user_id = match get_user_id(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    // ================= VALIDATION =================
    if data.title.trim().is_empty() {
        return Ok(HttpResponse::BadRequest().body("Title is required"));
    }

    // Participants are optional. If the user sends none, the meeting is
    // created without invites — useful for personal blocks (focus time,
    // hold a slot). If the array contains garbage entries we silently
    // filter them; we don't reject the whole request.
    let participants: Vec<String> = data
        .participants
        .iter()
        .map(|e| e.trim().to_lowercase())
        .filter(|e| e.contains("@") && e.contains("."))
        .collect();

    // ================= TIME =================
    let start_time: NaiveTime = minutes_to_time(data.start);
    let end_time: NaiveTime = minutes_to_time(data.end);

    if start_time >= end_time {
        return Ok(HttpResponse::BadRequest().body("Invalid time range"));
    }

    // ================= DATE =================
    let date = match NaiveDate::parse_from_str(&data.date, "%Y-%m-%d") {
        Ok(d) => d,
        Err(_) => return Ok(HttpResponse::BadRequest().body("Invalid date")),
    };

    // Prevent past meetings — interpret date+start as wall-clock time in the
    // client's IANA timezone. Default to UTC if the client didn't send one
    // (or sent something unparseable) — UTC is a neutral fallback that won't
    // spuriously reject future meetings the way a hardcoded NY zone did.
    let tz: Tz = data
        .tz
        .as_deref()
        .and_then(|s| Tz::from_str(s).ok())
        .unwrap_or(Tz::UTC);

    let naive = NaiveDateTime::new(date, start_time);
    let meeting_utc = match tz.from_local_datetime(&naive).single() {
        Some(dt) => dt.with_timezone(&Utc),
        None => return Ok(HttpResponse::BadRequest().body("Invalid date/time")),
    };
    if meeting_utc <= Utc::now() {
        return Ok(HttpResponse::BadRequest().body("Meeting cannot be in the past"));
    }

    // ================= ZOOM MEETING =================
    // Tolerant: if Zoom is misconfigured or fails, still create the meeting
    // without a join link rather than blocking the user.
    let duration_min = (end_time - start_time).num_minutes();
    let zoom_join_url = match create_zoom_meeting(&data.title, meeting_utc, duration_min).await {
        Ok(url) => Some(url),
        Err(e) => {
            warn!(
                "Zoom meeting create failed: {} (continuing without join url)",
                e
            );
            None
        }
    };

    let (title_iv, title_encrypted) = encrypt_required_field(&data.title)?;
    let (zoom_join_url_iv, zoom_join_url_encrypted) =
        encrypt_optional_field(zoom_join_url.as_deref())?;
    let encrypted_participants: Vec<(String, String)> = participants
        .iter()
        .map(|email| encrypt_required_field(email))
        .collect::<Result<Vec<_>, _>>()?;
    let participant_ivs: Vec<String> = encrypted_participants
        .iter()
        .map(|(iv, _)| iv.clone())
        .collect();
    let participant_encrypted: Vec<String> = encrypted_participants
        .iter()
        .map(|(_, encrypted)| encrypted.clone())
        .collect();

    // ================= TRANSACTION =================
    // A `?` on any statement below drops `tx`, which rolls back automatically.
    let mut tx = pool.begin().await?;

    // ================= INSERT MEETING =================
    let meeting = sqlx::query(
        r#"
        INSERT INTO meetings (
            title, title_encrypted, title_iv, date, start_time, end_time,
            user_id, zoom_join_url, zoom_join_url_encrypted, zoom_join_url_iv
        )
        VALUES ('', $1, $2, $3, $4, $5, $6, NULL, $7, $8)
        RETURNING id
        "#,
    )
    .bind(&title_encrypted)
    .bind(&title_iv)
    .bind(date)
    .bind(start_time)
    .bind(end_time)
    .bind(user_id)
    .bind(&zoom_join_url_encrypted)
    .bind(&zoom_join_url_iv)
    .fetch_one(&mut *tx)
    .await?;

    let meeting_id: i32 = meeting.get("id");

    // ================= INSERT PARTICIPANTS =================
    sqlx::query(
        r#"
        INSERT INTO meeting_participants (meeting_id, email, email_encrypted, email_iv, user_id)
        SELECT
            $1,
            '',
            v.email_encrypted,
            v.email_iv,
            u.id
        FROM UNNEST($2::text[], $3::text[], $4::text[]) AS v(email, email_encrypted, email_iv)
        LEFT JOIN users u
        ON LOWER(TRIM(u.email)) = LOWER(TRIM(v.email))
        ON CONFLICT DO NOTHING;
        "#,
    )
    .bind(meeting_id)
    .bind(&participants)
    .bind(&participant_encrypted)
    .bind(&participant_ivs)
    .execute(&mut *tx)
    .await?;

    // ================= COMMIT =================
    tx.commit().await?;
    info!(
        "Meeting created: id={} user_id={} title=\"{}\"",
        meeting_id, user_id, data.title
    );

    // ================= BACKGROUND EMAIL =================
    let pool_clone = pool.clone();

    let email_req = MeetingEmailRequest {
        user_id,
        participants: participants.clone(),
        title: data.title.clone(),
        date,
        start: start_time,
        end: end_time,
        kind: MeetingEmailKind::Invite,
        zoom_join_url: zoom_join_url.clone(),
    };

    actix_web::rt::spawn(async move {
        if let Err(e) = send_meeting_emails(pool_clone.get_ref(), email_req).await {
            warn!(target: "scheduler", meeting_id, error = %e, "invite email failed");
        }
    });

    // ================= WEBHOOK FAN-OUT =================
    // Plaintext title/date/time only — encrypted-at-rest columns are an
    // internal storage concern, not part of the public event contract.
    let owner = crate::webhooks::handler::owner_for_user(pool.get_ref(), user_id).await;
    crate::webhooks::emit(
        pool.get_ref(),
        owner,
        crate::webhooks::Event::MeetingCreated,
        serde_json::json!({
            "id": meeting_id,
            "title": data.title,
            "date": date,
            "start_time": start_time,
            "end_time": end_time,
            "zoom_join_url": zoom_join_url,
            "participants": participants,
        }),
    )
    .await;

    // ================= RESPONSE =================
    Ok(HttpResponse::Ok().json(MeetingResponse {
        message: "Meeting created successfully".into(),
        meeting_id,
    }))
}

// ================= GET =================
#[get("/meetings")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_meetings(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match get_user_id(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    let rows = sqlx::query(
        r#"
        SELECT
            m.id,
            m.title,
            m.title_encrypted,
            m.title_iv,
            m.date,
            m.start_time,
            m.end_time,
            m.zoom_join_url,
            m.zoom_join_url_encrypted,
            m.zoom_join_url_iv,
            m.source,
            mp.email AS participant_email,
            mp.email_encrypted AS participant_email_encrypted,
            mp.email_iv AS participant_email_iv
        FROM meetings m
        LEFT JOIN meeting_participants mp ON mp.meeting_id = m.id
        WHERE m.user_id = $1
        ORDER BY m.date, m.start_time, m.id, mp.id
        "#,
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    let mut meetings = Vec::<Meeting>::new();
    let mut indexes = HashMap::<i32, usize>::new();

    for row in rows {
        let meeting_id: i32 = row.get("id");
        let index = match indexes.get(&meeting_id) {
            Some(index) => *index,
            None => {
                let meeting = Meeting {
                    id: meeting_id,
                    title: decrypt_text_field(
                        row.try_get("title_iv").ok(),
                        row.try_get("title_encrypted").ok(),
                        row.try_get("title").ok(),
                    ),
                    date: row.get("date"),
                    start_time: row.get("start_time"),
                    end_time: row.get("end_time"),
                    participants: Vec::new(),
                    zoom_join_url: decrypt_optional_text_field(
                        row.try_get("zoom_join_url_iv").ok(),
                        row.try_get("zoom_join_url_encrypted").ok(),
                        row.try_get("zoom_join_url").ok(),
                    ),
                    source: row.get("source"),
                };

                meetings.push(meeting);
                let new_index = meetings.len() - 1;
                indexes.insert(meeting_id, new_index);
                new_index
            }
        };

        let participant = decrypt_optional_text_field(
            row.try_get("participant_email_iv").ok(),
            row.try_get("participant_email_encrypted").ok(),
            row.try_get("participant_email").ok(),
        );
        if let Some(participant) = participant
            && !participant.is_empty()
        {
            meetings[index].participants.push(participant);
        }
    }

    Ok(HttpResponse::Ok().json(meetings))
}

#[put("/meetings/{id}")]
#[instrument(target = "scheduler", skip(req, path, data, pool))]
pub async fn update_meeting(
    req: HttpRequest,
    path: web::Path<i32>,
    data: web::Json<CreateMeeting>,
    pool: web::Data<PgPool>,
) -> AppResult {
    let user_id = match get_user_id(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    let id = path.into_inner();

    // ================= VALIDATION =================
    if data.title.trim().is_empty() {
        return Ok(HttpResponse::BadRequest().body("Title is required"));
    }

    // Participants optional — see `create_meeting` above for rationale.

    let date = match chrono::NaiveDate::parse_from_str(&data.date, "%Y-%m-%d") {
        Ok(d) => d,
        Err(_) => return Ok(HttpResponse::BadRequest().body("Invalid date format")),
    };

    let start_time = minutes_to_time(data.start);
    let end_time = minutes_to_time(data.end);

    if start_time >= end_time {
        return Ok(HttpResponse::BadRequest().body("Invalid time range"));
    }

    // ================= LOAD EXISTING (for change detection) =================
    let existing = sqlx::query(
        r#"
        SELECT title, title_encrypted, title_iv, date, start_time, end_time,
               zoom_join_url, zoom_join_url_encrypted, zoom_join_url_iv
        FROM meetings
        WHERE id = $1 AND user_id = $2
        "#,
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .map(|row| {
        (
            decrypt_text_field(
                row.try_get("title_iv").ok(),
                row.try_get("title_encrypted").ok(),
                row.try_get("title").ok(),
            ),
            row.get::<NaiveDate, _>("date"),
            row.get::<NaiveTime, _>("start_time"),
            row.get::<NaiveTime, _>("end_time"),
            decrypt_optional_text_field(
                row.try_get("zoom_join_url_iv").ok(),
                row.try_get("zoom_join_url_encrypted").ok(),
                row.try_get("zoom_join_url").ok(),
            ),
        )
    });

    if existing.is_none() {
        return Ok(HttpResponse::NotFound().finish());
    }

    let (title_iv, title_encrypted) = encrypt_required_field(&data.title)?;
    let participants: Vec<String> = data
        .participants
        .iter()
        .map(|email| email.trim().to_lowercase())
        .filter(|email| email.contains("@") && email.contains("."))
        .collect();

    // Participants optional — if all submitted entries were garbage we end
    // up with an empty list here and continue. The downstream INSERT uses
    // UNNEST on the array, which handles zero-length input cleanly, and
    // the email-send block below is already guarded with `!is_empty()`.

    let encrypted_participants: Vec<(String, String)> = participants
        .iter()
        .map(|email| encrypt_required_field(email))
        .collect::<Result<Vec<_>, _>>()?;
    let participant_ivs: Vec<String> = encrypted_participants
        .iter()
        .map(|(iv, _)| iv.clone())
        .collect();
    let participant_encrypted: Vec<String> = encrypted_participants
        .iter()
        .map(|(_, encrypted)| encrypted.clone())
        .collect();

    // ================= TRANSACTION =================
    // A `?` on any statement below drops `tx`, which rolls back automatically.
    let mut tx = pool.begin().await?;

    // ================= UPDATE MEETING =================
    sqlx::query(
        r#"
        UPDATE meetings
        SET title='', title_encrypted=$1, title_iv=$2,
            date=$3, start_time=$4, end_time=$5
        WHERE id=$6 AND user_id=$7
        "#,
    )
    .bind(&title_encrypted)
    .bind(&title_iv)
    .bind(date)
    .bind(start_time)
    .bind(end_time)
    .bind(id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    // ================= DELETE OLD PARTICIPANTS =================
    sqlx::query(
        r#"
        DELETE FROM meeting_participants mp
        USING meetings m
        WHERE mp.meeting_id = m.id
          AND mp.meeting_id = $1
          AND m.user_id = $2
        "#,
    )
    .bind(id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    // ================= INSERT NEW PARTICIPANTS =================
    sqlx::query(
        r#"
        INSERT INTO meeting_participants (meeting_id, email, email_encrypted, email_iv, user_id)
        SELECT
            $1,
            '',
            v.email_encrypted,
            v.email_iv,
            u.id
        FROM UNNEST($2::text[], $3::text[], $4::text[]) AS v(email, email_encrypted, email_iv)
        LEFT JOIN users u
        ON LOWER(TRIM(u.email)) = LOWER(TRIM(v.email))
        "#,
    )
    .bind(id)
    .bind(&participants)
    .bind(&participant_encrypted)
    .bind(&participant_ivs)
    .execute(&mut *tx)
    .await?;

    // ================= COMMIT =================
    tx.commit().await?;
    info!("Meeting updated: id={} user_id={}", id, user_id);

    // ================= NOTIFY ON CONTENT CHANGES =================
    // Email participants only when title/date/start/end actually changed —
    // a participant-list-only edit should not spam everyone.
    let (content_changed, existing_zoom_url) = match &existing {
        Some((t, d, s, e, z)) => (
            t != &data.title || d != &date || s != &start_time || e != &end_time,
            z.clone(),
        ),
        None => (false, None),
    };

    if content_changed && !participants.is_empty() {
        let pool_clone = pool.clone();
        let email_req = MeetingEmailRequest {
            user_id,
            participants,
            title: data.title.clone(),
            date,
            start: start_time,
            end: end_time,
            kind: MeetingEmailKind::Update,
            zoom_join_url: existing_zoom_url,
        };
        actix_web::rt::spawn(async move {
            if let Err(e) = send_meeting_emails(pool_clone.get_ref(), email_req).await {
                warn!(target: "scheduler", meeting_id = id, error = %e, "update email failed");
            }
        });
    }

    // ================= WEBHOOK FAN-OUT =================
    let owner = crate::webhooks::handler::owner_for_user(pool.get_ref(), user_id).await;
    crate::webhooks::emit(
        pool.get_ref(),
        owner,
        crate::webhooks::Event::MeetingUpdated,
        serde_json::json!({
            "id": id,
            "title": data.title,
            "date": date,
            "start_time": start_time,
            "end_time": end_time,
            "content_changed": content_changed,
        }),
    )
    .await;

    // ================= RESPONSE =================
    Ok(HttpResponse::Ok().json(json!({
        "message": "Meeting updated successfully"
    })))
}

#[delete("/meetings/{id}")]
#[instrument(target = "scheduler", skip(req, path, pool))]
pub async fn delete_meeting(
    req: HttpRequest,
    path: web::Path<i32>,
    pool: web::Data<PgPool>,
) -> AppResult {
    let user_id = match get_user_id(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    let id = path.into_inner();

    // Snapshot meeting + participants before deletion so we can email them.
    let snapshot = sqlx::query(
        r#"
        SELECT title, title_encrypted, title_iv, date, start_time, end_time,
               zoom_join_url, zoom_join_url_encrypted, zoom_join_url_iv
        FROM meetings
        WHERE id = $1 AND user_id = $2
        "#,
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .map(|row| {
        (
            decrypt_text_field(
                row.try_get("title_iv").ok(),
                row.try_get("title_encrypted").ok(),
                row.try_get("title").ok(),
            ),
            row.get::<NaiveDate, _>("date"),
            row.get::<NaiveTime, _>("start_time"),
            row.get::<NaiveTime, _>("end_time"),
            decrypt_optional_text_field(
                row.try_get("zoom_join_url_iv").ok(),
                row.try_get("zoom_join_url_encrypted").ok(),
                row.try_get("zoom_join_url").ok(),
            ),
        )
    });

    // A failed participant read is non-fatal — the meeting is still deleted,
    // we just skip the cancellation emails.
    let participants: Vec<String> = match sqlx::query(
        r#"
        SELECT mp.email, mp.email_encrypted, mp.email_iv
        FROM meeting_participants mp
        JOIN meetings m ON m.id = mp.meeting_id
        WHERE mp.meeting_id = $1 AND m.user_id = $2
        "#,
    )
    .bind(id)
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await
    {
        Ok(rows) => rows
            .into_iter()
            .filter_map(|r| {
                decrypt_optional_text_field(
                    r.try_get("email_iv").ok(),
                    r.try_get("email_encrypted").ok(),
                    r.try_get("email").ok(),
                )
            })
            .collect(),
        Err(e) => {
            warn!(target: "db", meeting_id = id, error = ?e, "delete_meeting load participants failed");
            Vec::new()
        }
    };

    let done = sqlx::query("DELETE FROM meetings WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;

    if done.rows_affected() == 0 {
        return Ok(HttpResponse::NotFound().finish());
    }

    if let Some((title, date, start_time, end_time, zoom_join_url)) = snapshot
        && !participants.is_empty()
    {
        let pool_clone = pool.clone();
        let email_req = MeetingEmailRequest {
            user_id,
            participants,
            title,
            date,
            start: start_time,
            end: end_time,
            kind: MeetingEmailKind::Cancel,
            zoom_join_url,
        };
        actix_web::rt::spawn(async move {
            if let Err(e) = send_meeting_emails(pool_clone.get_ref(), email_req).await {
                warn!(target: "scheduler", meeting_id = id, error = %e, "cancel email failed");
            }
        });
    }
    info!("Meeting deleted: id={} user_id={}", id, user_id);

    // ================= WEBHOOK FAN-OUT =================
    let owner = crate::webhooks::handler::owner_for_user(pool.get_ref(), user_id).await;
    crate::webhooks::emit(
        pool.get_ref(),
        owner,
        crate::webhooks::Event::MeetingDeleted,
        serde_json::json!({ "id": id }),
    )
    .await;

    Ok(HttpResponse::Ok().json(json!({
        "message": "Meeting deleted"
    })))
}
