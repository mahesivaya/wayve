// GET /api/home/summary — single-shot aggregate that powers the signed-in
// home page's Activity Dashboard. Replaces 4-6 separate fetches the
// frontend used to make (full inbox + all meetings + all tasks + all
// notes) with one round-trip that returns only what the dashboard renders.
//
// All six SQL queries run concurrently via `tokio::try_join!` against the
// same connection pool. Each is bounded by `LIMIT 5`, and the unread
// count is a partial-index scan, so total wall time ≈ slowest single
// query rather than the sum.

use crate::prelude::*;
use chrono::{Local, NaiveDateTime, NaiveTime};
use sqlx::Row;
use tracing::instrument;
use wayve_security::encryption::decrypt;
use wayve_security::jwt::get_user_id_from_request;

#[derive(Serialize)]
pub struct HomeSummary {
    pub today: TodaySummary,
    pub inbox: InboxSummary,
    pub tasks: TasksSummary,
    pub recent: Vec<RecentItem>,
}

#[derive(Serialize)]
pub struct TodaySummary {
    pub events: Vec<MeetingPreview>,
}

#[derive(Serialize)]
pub struct MeetingPreview {
    pub id: i32,
    pub title: String,
    pub start_time: String,
    pub end_time: String,
    pub participants_count: i64,
}

#[derive(Serialize)]
pub struct InboxSummary {
    pub unread_count: i64,
    pub preview: Vec<EmailPreview>,
}

#[derive(Serialize)]
pub struct EmailPreview {
    pub id: i32,
    pub sender: Option<String>,
    pub subject: Option<String>,
    pub created_at: Option<NaiveDateTime>,
}

#[derive(Serialize)]
pub struct TasksSummary {
    pub top: Vec<TaskPreview>,
}

#[derive(Serialize)]
pub struct TaskPreview {
    pub id: i32,
    pub name: String,
    pub status: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RecentItem {
    Note {
        id: i32,
        title: Option<String>,
        ts: Option<NaiveDateTime>,
    },
    Email {
        id: i32,
        title: Option<String>,
        ts: Option<NaiveDateTime>,
    },
}

#[get("/home/summary")]
#[instrument(target = "http", skip(req, pool))]
// `tokio::try_join!` macro-expands to internals that trip the project's
// `clippy::disallowed-methods` ban on `unwrap`/`expect`. The expansion is
// upstream code we don't author, so suppress the lint at the function
// scope rather than on every macro invocation.
#[allow(clippy::disallowed_methods)]
pub async fn home_summary(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let today = Local::now().date_naive();
    let pool_ref = pool.get_ref();

    // All queries run concurrently. Each is bounded; the partial-index
    // unread COUNT is index-only so it's fast even on large inboxes.
    let (meeting_rows, unread_count, unread_rows, task_rows, note_rows, recent_email_rows) = tokio::try_join!(
        sqlx::query(
            "SELECT m.id, m.title, m.title_iv, m.title_encrypted,
                    m.start_time, m.end_time,
                    (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.meeting_id = m.id) AS participants_count
             FROM meetings m
             WHERE m.user_id = $1 AND m.date = $2
             ORDER BY m.start_time ASC
             LIMIT 5",
        )
        .bind(user_id)
        .bind(today)
        .fetch_all(pool_ref),
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)
             FROM emails e
             JOIN email_accounts a ON a.id = e.account_id
             WHERE a.user_id = $1 AND e.is_read = false",
        )
        .bind(user_id)
        .fetch_one(pool_ref),
        sqlx::query(
            "SELECT e.id, e.sender, e.subject, e.subject_iv, e.subject_encrypted, e.created_at
             FROM emails e
             JOIN email_accounts a ON a.id = e.account_id
             WHERE a.user_id = $1 AND e.is_read = false
             ORDER BY e.created_at DESC
             LIMIT 5",
        )
        .bind(user_id)
        .fetch_all(pool_ref),
        sqlx::query(
            "SELECT id, name, status
             FROM tasks
             WHERE user_id = $1 AND status != 'done'
             ORDER BY priority DESC, created_at DESC
             LIMIT 5",
        )
        .bind(user_id)
        .fetch_all(pool_ref),
        sqlx::query(
            "SELECT id, title, updated_at
             FROM notes
             WHERE user_id = $1
             ORDER BY updated_at DESC
             LIMIT 5",
        )
        .bind(user_id)
        .fetch_all(pool_ref),
        sqlx::query(
            "SELECT e.id, e.subject, e.subject_iv, e.subject_encrypted, e.created_at
             FROM emails e
             JOIN email_accounts a ON a.id = e.account_id
             WHERE a.user_id = $1
             ORDER BY e.created_at DESC
             LIMIT 3",
        )
        .bind(user_id)
        .fetch_all(pool_ref),
    )?;

    let events: Vec<MeetingPreview> = meeting_rows
        .into_iter()
        .map(|row| {
            let id: i32 = row.get("id");
            let title = decrypt_or_legacy(
                row.try_get::<Option<String>, _>("title_iv").ok().flatten(),
                row.try_get::<Option<String>, _>("title_encrypted")
                    .ok()
                    .flatten(),
                row.try_get::<Option<String>, _>("title").ok().flatten(),
            )
            .unwrap_or_default();
            let start = row
                .try_get::<NaiveTime, _>("start_time")
                .map(format_hm)
                .unwrap_or_default();
            let end = row
                .try_get::<NaiveTime, _>("end_time")
                .map(format_hm)
                .unwrap_or_default();
            let participants_count: i64 = row.try_get("participants_count").unwrap_or(0);
            MeetingPreview {
                id,
                title,
                start_time: start,
                end_time: end,
                participants_count,
            }
        })
        .collect();

    let preview: Vec<EmailPreview> = unread_rows
        .into_iter()
        .map(|row| EmailPreview {
            id: row.get("id"),
            sender: row.try_get::<Option<String>, _>("sender").ok().flatten(),
            subject: decrypt_or_legacy(
                row.try_get::<Option<String>, _>("subject_iv").ok().flatten(),
                row.try_get::<Option<String>, _>("subject_encrypted")
                    .ok()
                    .flatten(),
                row.try_get::<Option<String>, _>("subject").ok().flatten(),
            ),
            created_at: row
                .try_get::<Option<NaiveDateTime>, _>("created_at")
                .ok()
                .flatten(),
        })
        .collect();

    let top: Vec<TaskPreview> = task_rows
        .into_iter()
        .map(|row| TaskPreview {
            id: row.get("id"),
            name: row.try_get::<String, _>("name").unwrap_or_default(),
            status: row.try_get::<String, _>("status").unwrap_or_default(),
        })
        .collect();

    // Recent = notes (newest by updated_at) + 3 most recent emails (any
    // read state). Merged + re-sorted in Rust because the column types
    // don't match; the underlying queries each return ≤5 rows so this is
    // cheap.
    let mut recent: Vec<(NaiveDateTime, RecentItem)> = Vec::new();

    for row in note_rows {
        let id: i32 = row.get("id");
        let title: Option<String> = row.try_get::<Option<String>, _>("title").ok().flatten();
        let ts: Option<NaiveDateTime> = row
            .try_get::<Option<NaiveDateTime>, _>("updated_at")
            .ok()
            .flatten();
        if let Some(stamp) = ts {
            recent.push((
                stamp,
                RecentItem::Note {
                    id,
                    title,
                    ts: Some(stamp),
                },
            ));
        }
    }

    for row in recent_email_rows {
        let id: i32 = row.get("id");
        let subject = decrypt_or_legacy(
            row.try_get::<Option<String>, _>("subject_iv").ok().flatten(),
            row.try_get::<Option<String>, _>("subject_encrypted")
                .ok()
                .flatten(),
            row.try_get::<Option<String>, _>("subject").ok().flatten(),
        );
        let ts: Option<NaiveDateTime> = row
            .try_get::<Option<NaiveDateTime>, _>("created_at")
            .ok()
            .flatten();
        if let Some(stamp) = ts {
            recent.push((
                stamp,
                RecentItem::Email {
                    id,
                    title: subject,
                    ts: Some(stamp),
                },
            ));
        }
    }

    recent.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    recent.truncate(5);
    let recent: Vec<RecentItem> = recent.into_iter().map(|(_, item)| item).collect();

    Ok(HttpResponse::Ok().json(HomeSummary {
        today: TodaySummary { events },
        inbox: InboxSummary {
            unread_count,
            preview,
        },
        tasks: TasksSummary { top },
        recent,
    }))
}

/// Mirror of the same helper in `scheduler::handler` / `email::repo`: prefer
/// the AES-GCM envelope (iv + ciphertext) but fall back to the legacy
/// plaintext column for rows that predate the encryption migration. Returns
/// `None` only when both paths are empty.
fn decrypt_or_legacy(
    iv: Option<String>,
    encrypted: Option<String>,
    legacy_plaintext: Option<String>,
) -> Option<String> {
    if let (Some(iv), Some(enc)) = (iv.as_deref(), encrypted.as_deref())
        && !iv.is_empty()
        && !enc.is_empty()
        && let Ok(plain) = decrypt(iv, enc)
    {
        return Some(plain);
    }
    legacy_plaintext.filter(|s| !s.is_empty())
}

fn format_hm(time: NaiveTime) -> String {
    time.format("%H:%M").to_string()
}
