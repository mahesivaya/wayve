use crate::models::scheduler::{CreateMeeting, Meeting};
use crate::prelude::*;
use crate::scheduler::auth::get_user_id;
use crate::scheduler::create_meeting::{ValidatedMeetingInput, validate_create_meeting};
use crate::scheduler::email_notifications::{
    MeetingEmailKind, MeetingEmailRequest, send_meeting_emails,
};
use crate::scheduler::time::minutes_to_time;
use crate::scheduler::zoom::{ZoomError, create_zoom_meeting};
use actix_web::{HttpRequest, HttpResponse, delete, post, put, web};
use chrono::Utc;
use serde_json::json;
use std::collections::HashMap;
use tracing::{info, instrument, warn};
use wayve_security::encryption::{decrypt, encrypt};

use chrono::{NaiveDate, NaiveTime};
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
    let user_id = match get_user_id(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    let ValidatedMeetingInput {
        title,
        participants,
        date,
        start_time,
        end_time,
        meeting_utc,
        duration_min,
    } = match validate_create_meeting(&data, Utc::now()) {
        Ok(v) => v,
        Err(e) => return Ok(HttpResponse::BadRequest().body(e.message())),
    };

    // Tolerant: if Zoom is misconfigured or fails, still create the meeting
    // without a join link rather than blocking the user.
    let zoom_join_url = match create_zoom_meeting(&title, meeting_utc, duration_min).await {
        Ok(url) => Some(url),
        Err(e) => {
            warn!(
                "Zoom meeting create failed: {} (continuing without join url)",
                e
            );
            None
        }
    };

    let (title_iv, title_encrypted) = encrypt_required_field(&title)?;
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

    // A `?` on any statement below drops `tx`, which rolls back automatically.
    let mut tx = pool.begin().await?;

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

    tx.commit().await?;
    info!(
        "Meeting created: id={} user_id={} title=\"{}\"",
        meeting_id, user_id, title
    );

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "meeting_created",
            resource_type: "meeting",
            resource_id: Some(meeting_id.to_string()),
            metadata: Some(serde_json::json!({
                "title": title.clone(),
                "date": date,
                "start_time": start_time,
                "end_time": end_time,
                "participants": participants.clone(),
            })),
        },
    )
    .await;
    let invited_user_ids: Vec<i32> = sqlx::query_scalar(
        "SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND user_id IS NOT NULL",
    )
    .bind(meeting_id)
    .fetch_all(pool.get_ref())
    .await
    .unwrap_or_default();
    for invitee_id in invited_user_ids {
        crate::audit::record_action_system(
            pool.get_ref(),
            crate::audit::AuditEvent {
                actor_user_id: invitee_id,
                action: "meeting_invited",
                resource_type: "meeting",
                resource_id: Some(meeting_id.to_string()),
                metadata: Some(serde_json::json!({
                    "title": title.clone(),
                    "date": date,
                    "start_time": start_time,
                    "end_time": end_time,
                    "organizer_id": user_id,
                    "status": "pending",
                })),
            },
        )
        .await;
    }

    let pool_clone = pool.clone();

    let email_req = MeetingEmailRequest {
        user_id,
        participants: participants.clone(),
        title: title.clone(),
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

    // Plaintext title, date, and time only: the encrypted-at-rest columns are an
    // internal storage concern, not part of the public event contract.
    let owner = crate::webhooks::handler::owner_for_user(pool.get_ref(), user_id).await;
    crate::webhooks::emit(
        pool.get_ref(),
        owner,
        crate::webhooks::Event::MeetingCreated,
        serde_json::json!({
            "id": meeting_id,
            "title": title,
            "date": date,
            "start_time": start_time,
            "end_time": end_time,
            "zoom_join_url": zoom_join_url,
            "participants": participants,
        }),
    )
    .await;

    Ok(HttpResponse::Ok().json(MeetingResponse {
        message: "Meeting created successfully".into(),
        meeting_id,
    }))
}

/// Map a Zoom mint result to the `POST /api/meetings/link` response. Split out so
/// the status mapping can be unit-tested without a live Zoom call.
pub(crate) fn meeting_link_response(result: Result<String, ZoomError>) -> HttpResponse {
    match result {
        Ok(join_url) => HttpResponse::Ok().json(json!({ "join_url": join_url })),
        Err(ZoomError::MissingEnv(_)) => HttpResponse::ServiceUnavailable()
            .body("Video meetings are not configured on this server."),
        Err(e) => {
            warn!(target: "scheduler", error = %e, "meeting link mint failed");
            HttpResponse::BadGateway().body("Could not create a meeting link. Please try again.")
        }
    }
}

/// Mint an instant, shareable Zoom meeting link. No inputs and no DB row: the link
/// is a shared Zoom room anyone holding the URL can join, which the user copies and
/// pastes wherever they want.
#[post("/meetings/link")]
#[instrument(target = "scheduler", skip(req, pool))]
pub async fn create_meeting_link(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match get_user_id(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    let result = create_zoom_meeting("Instant meeting", Utc::now(), 60).await;

    if result.is_ok() {
        info!(target: "scheduler", user_id, "instant meeting link created");
        crate::audit::record_action(
            pool.get_ref(),
            &req,
            crate::audit::AuditEvent {
                actor_user_id: user_id,
                action: "meeting_link_created",
                resource_type: "meeting_link",
                resource_id: None,
                metadata: None,
            },
        )
        .await;
    }

    Ok(meeting_link_response(result))
}

#[get("/meetings")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_meetings(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match get_user_id(&req) {
        Ok(id) => id,
        Err(resp) => return Ok(resp),
    };

    let rows = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
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
        .fetch_all(&mut *tx)
        .await?;
        Ok((tx, rows))
    })
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

    if data.title.trim().is_empty() {
        return Ok(HttpResponse::BadRequest().body("Title is required"));
    }

    let date = match chrono::NaiveDate::parse_from_str(&data.date, "%Y-%m-%d") {
        Ok(d) => d,
        Err(_) => return Ok(HttpResponse::BadRequest().body("Invalid date format")),
    };

    let start_time = minutes_to_time(data.start);
    let end_time = minutes_to_time(data.end);

    if start_time >= end_time {
        return Ok(HttpResponse::BadRequest().body("Invalid time range"));
    }

    // Loaded so the notify step below can tell what actually changed.
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

    // Participants are optional, so an all-garbage list becomes an empty one and
    // the request continues: the UNNEST insert handles zero rows and the email
    // block is guarded on `!is_empty()`.
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

    // A `?` on any statement below drops `tx`, which rolls back automatically.
    let mut tx = pool.begin().await?;

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

    tx.commit().await?;
    info!("Meeting updated: id={} user_id={}", id, user_id);

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "meeting_updated",
            resource_type: "meeting",
            resource_id: Some(id.to_string()),
            metadata: Some(serde_json::json!({
                "title": data.title.clone(),
                "date": date,
                "start_time": start_time,
                "end_time": end_time,
                "participants": participants.clone(),
            })),
        },
    )
    .await;

    // Email participants only when the title, date, or times changed; a
    // participant-list-only edit should not spam everyone.
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

    // Non-fatal: the meeting is still deleted, only the cancellation emails are
    // skipped.
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

    if let Some((title, date, start_time, end_time, _zoom)) = snapshot.clone() {
        crate::audit::record_action(
            pool.get_ref(),
            &req,
            crate::audit::AuditEvent {
                actor_user_id: user_id,
                action: "meeting_canceled",
                resource_type: "meeting",
                resource_id: Some(id.to_string()),
                metadata: Some(serde_json::json!({
                    "title": title,
                    "date": date,
                    "start_time": start_time,
                    "end_time": end_time,
                })),
            },
        )
        .await;
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
