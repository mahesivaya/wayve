// Single source of truth for every read/write against the `emails` table.
//
// Handlers (`routes::email`, `email::body_handlers`, `platform_team::handler`)
// and the sync/outlook workers used to inline raw SQL plus their own
// row-to-JSON serialisation, which made any column change a 6+ file edit.
// Everything now flows through this module: handlers pass typed structs in
// and get typed structs out, the repo owns SELECT projection lists, INSERT
// shapes, and at-rest crypto for any encrypted columns. Adding or
// encrypting a column = one place.
//
// Scope notes:
//   * Body encryption stays in `body_handlers` for now — the body-fetch
//     path also refetches from Gmail when the local row is empty, and
//     pulling that into the repo would drag a Gmail client dependency.
//     The repo still exposes the raw `body_iv` / `body_encrypted` /
//     `attachments_checked` columns for those handlers.
//   * Subject is plaintext at the moment; encryption lives behind the
//     `read_subject` / `serialize_subject_for_storage` helpers so flipping
//     the storage shape is a one-file change here.

use chrono::NaiveDateTime;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, QueryBuilder, Row};
use std::collections::HashMap;

// ─────────────────────────────────────────────────────────────────────
// Subject crypto seam (at-rest AES-256-GCM, same envelope as body_*)
// ─────────────────────────────────────────────────────────────────────
//
// On read: prefer subject_encrypted + subject_iv; fall back to the legacy
// plaintext `subject` column for rows that predate the migration. Once
// `backfill_email_subjects` finishes, every row reads from the encrypted
// pair and the plain column is permanently NULL.
//
// On write: callers pass a plain &str. The repo encrypts it, writes the
// envelope pair, and sets the plaintext column to NULL — even on UPDATEs.
// Stale plaintexts can't outlive a write that touches this row.

/// New rows persist the subject as `(subject_iv, subject_encrypted)` and
/// leave the legacy plaintext column NULL. Returns `(iv, ciphertext)`.
fn encrypt_subject_for_storage(subject: &str) -> (String, String) {
    if subject.is_empty() {
        return (String::new(), String::new());
    }
    match wayve_security::encryption::encrypt(subject) {
        Ok((iv, ciphertext)) => (iv, ciphertext),
        Err(_) => (String::new(), String::new()),
    }
}

fn read_subject(row: &PgRow) -> Option<String> {
    let enc: Option<String> = row.try_get("subject_encrypted").ok().flatten();
    let iv: Option<String> = row.try_get("subject_iv").ok().flatten();
    if let (Some(e), Some(i)) = (enc.as_deref(), iv.as_deref())
        && !e.is_empty()
        && !i.is_empty()
        && let Ok(plain) = wayve_security::encryption::decrypt(i, e)
    {
        return Some(plain);
    }
    row.try_get::<Option<String>, _>("subject").ok().flatten()
}

// ─────────────────────────────────────────────────────────────────────
// Read: list
// ─────────────────────────────────────────────────────────────────────

/// One row in the inbox/folder list. Shared-inbox fields collapse to
/// `is_shared = false` / `None` when the user is viewing a personal
/// mailbox (the LEFT JOINs just don't match).
pub struct EmailListRow {
    pub id: i32,
    pub gmail_id: String,
    pub account_id: Option<i32>,
    pub subject: Option<String>,
    pub sender: Option<String>,
    pub receiver: Option<String>,
    pub has_body: bool,
    pub has_attachments: bool,
    pub is_read: bool,
    pub created_at: Option<NaiveDateTime>,
    pub is_shared: bool,
    pub shared_label: Option<String>,
    pub inbox_status: Option<String>,
    pub inbox_assignee_id: Option<i32>,
}

pub struct EmailListFilters {
    pub user_id: i32,
    pub account_id: Option<i32>,
    pub folder: Option<String>,
    pub inbox_status: Option<String>,
    pub search: Option<String>,
    /// (timestamp_ms, id) keyset cursor. Both must be present to take effect.
    pub before: Option<(i64, i32)>,
    pub page_size: usize,
}

pub async fn list(pool: &PgPool, filters: EmailListFilters) -> sqlx::Result<Vec<EmailListRow>> {
    // Fetch page_size + 1 so the caller can compute `has_more` from
    // `result.len() > page_size` without an extra COUNT round-trip.
    let query_limit = (filters.page_size + 1) as i64;

    let mut qb = QueryBuilder::new(
        r#"
        SELECT e.id, e.gmail_id, e.subject, e.subject_iv, e.subject_encrypted,
               e.sender, e.receiver,
               (e.body_encrypted <> '') AS has_body,
               EXISTS (
                   SELECT 1 FROM email_attachments ea WHERE ea.email_id = e.id
               ) AS has_attachments,
               e.account_id, e.is_read, e.created_at,
               a.is_shared, a.shared_label,
               s.status AS inbox_status, s.assignee_id AS inbox_assignee_id
        FROM emails e
        JOIN email_accounts a ON e.account_id = a.id
        LEFT JOIN shared_inbox_members sm
               ON sm.account_id = a.id AND sm.user_id =
        "#,
    );
    qb.push_bind(filters.user_id);
    qb.push(
        r#"
        LEFT JOIN shared_inbox_email_state s ON s.email_id = e.id
        WHERE (a.user_id =
        "#,
    );
    qb.push_bind(filters.user_id);
    qb.push(" OR sm.user_id IS NOT NULL)");

    if let Some(account_id) = filters.account_id {
        qb.push(" AND a.id = ");
        qb.push_bind(account_id);
    }

    if let Some(raw) = filters.inbox_status.as_deref().map(str::trim) {
        match raw {
            "open" | "pending" | "closed" => {
                qb.push(" AND s.status = ");
                qb.push_bind(raw.to_string());
            }
            "unassigned" => {
                qb.push(" AND s.email_id IS NOT NULL AND s.assignee_id IS NULL");
            }
            "mine" => {
                qb.push(" AND s.assignee_id = ");
                qb.push_bind(filters.user_id);
            }
            _ => {}
        }
    }

    if let Some(folder) = filters.folder.as_deref() {
        match folder {
            "inbox" => {
                qb.push(
                    " AND lower(coalesce(e.sender, '')) NOT LIKE '%' || lower(a.email) || '%' \
                       AND NOT ('SPAM' = ANY(e.labels)) AND NOT ('DRAFT' = ANY(e.labels)) ",
                );
            }
            "sent" => {
                qb.push(" AND lower(coalesce(e.sender, '')) LIKE '%' || lower(a.email) || '%' ");
            }
            "important" => {
                qb.push(" AND 'IMPORTANT' = ANY(e.labels) ");
            }
            "updates" => {
                qb.push(" AND 'CATEGORY_UPDATES' = ANY(e.labels) ");
            }
            "social" => {
                qb.push(" AND 'CATEGORY_SOCIAL' = ANY(e.labels) ");
            }
            "spam" => {
                qb.push(" AND 'SPAM' = ANY(e.labels) ");
            }
            "drafts" => {
                qb.push(" AND 'DRAFT' = ANY(e.labels) ");
            }
            _ => {}
        }
    }

    if let Some(search) = filters
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        // Subject is encrypted at rest so SQL `LIKE` can't match it; the
        // legacy plaintext column stays in the OR for not-yet-backfilled
        // rows. After backfill completes the subject clause becomes a
        // no-op — clients that need subject search must filter the
        // decrypted page client-side.
        let pattern = format!("%{}%", search.to_lowercase());
        qb.push(" AND (lower(coalesce(e.subject, '')) LIKE ");
        qb.push_bind(pattern.clone());
        qb.push(" OR lower(coalesce(e.sender, '')) LIKE ");
        qb.push_bind(pattern.clone());
        qb.push(" OR lower(coalesce(e.receiver, '')) LIKE ");
        qb.push_bind(pattern.clone());
        qb.push(" OR lower(coalesce(e.gmail_id, '')) LIKE ");
        qb.push_bind(pattern);
        qb.push(") ");
    }

    if let Some((before_ms, before_id)) = filters.before {
        qb.push(" AND (e.created_at, e.id) < (to_timestamp(");
        qb.push_bind(before_ms);
        qb.push("::double precision / 1000.0), ");
        qb.push_bind(before_id);
        qb.push(")");
    }

    qb.push(" ORDER BY e.created_at DESC, e.id DESC LIMIT ");
    qb.push_bind(query_limit);

    let raw = qb.build().fetch_all(pool).await?;
    Ok(raw.into_iter().map(map_list_row).collect())
}

fn map_list_row(row: PgRow) -> EmailListRow {
    EmailListRow {
        id: row.get::<i32, _>("id"),
        gmail_id: row.get::<String, _>("gmail_id"),
        account_id: row.try_get::<Option<i32>, _>("account_id").ok().flatten(),
        subject: read_subject(&row),
        sender: row.try_get::<Option<String>, _>("sender").ok().flatten(),
        receiver: row.try_get::<Option<String>, _>("receiver").ok().flatten(),
        has_body: row.try_get::<bool, _>("has_body").unwrap_or(false),
        has_attachments: row.try_get::<bool, _>("has_attachments").unwrap_or(false),
        is_read: row.try_get::<Option<bool>, _>("is_read").ok().flatten().unwrap_or(true),
        created_at: row.try_get("created_at").ok(),
        is_shared: row.try_get::<bool, _>("is_shared").unwrap_or(false),
        shared_label: row.try_get::<Option<String>, _>("shared_label").ok().flatten(),
        inbox_status: row.try_get::<Option<String>, _>("inbox_status").ok().flatten(),
        inbox_assignee_id: row.try_get::<Option<i32>, _>("inbox_assignee_id").ok().flatten(),
    }
}

// ─────────────────────────────────────────────────────────────────────
// Read: detail (single email, with body envelope)
// ─────────────────────────────────────────────────────────────────────

/// Single-row read for the `/emails/{id}` detail endpoint. Body stays as
/// the raw envelope (iv + ciphertext) so the caller can decrypt + cache.
pub struct EmailDetailRow {
    pub id: i32,
    pub account_id: Option<i32>,
    pub subject: Option<String>,
    pub sender: Option<String>,
    pub receiver: Option<String>,
    pub body_iv: String,
    pub body_encrypted: String,
    pub attachments_checked: bool,
}

pub async fn get_detail(
    pool: &PgPool,
    email_id: i32,
    user_id: i32,
) -> sqlx::Result<Option<EmailDetailRow>> {
    let row = sqlx::query(
        r#"
        SELECT e.id, e.account_id, e.subject, e.subject_iv, e.subject_encrypted,
               e.sender, e.receiver, e.body_encrypted, e.body_iv, e.attachments_checked
          FROM emails e
          JOIN email_accounts a ON e.account_id = a.id
          LEFT JOIN shared_inbox_members m
                 ON m.account_id = a.id AND m.user_id = $2
         WHERE e.id = $1
           AND (a.user_id = $2 OR m.user_id IS NOT NULL)
        "#,
    )
    .bind(email_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| EmailDetailRow {
        id: r.get::<i32, _>("id"),
        account_id: r.try_get::<Option<i32>, _>("account_id").ok().flatten(),
        subject: read_subject(&r),
        sender: r.try_get::<Option<String>, _>("sender").ok().flatten(),
        receiver: r.try_get::<Option<String>, _>("receiver").ok().flatten(),
        body_iv: r.try_get::<Option<String>, _>("body_iv").ok().flatten().unwrap_or_default(),
        body_encrypted: r
            .try_get::<Option<String>, _>("body_encrypted")
            .ok()
            .flatten()
            .unwrap_or_default(),
        attachments_checked: r
            .try_get::<Option<bool>, _>("attachments_checked")
            .ok()
            .flatten()
            .unwrap_or(false),
    }))
}

// ─────────────────────────────────────────────────────────────────────
// Read: subjects for a list of email ids (used by admin/inbox-queue views)
// ─────────────────────────────────────────────────────────────────────

pub async fn subjects_for_ids(
    pool: &PgPool,
    ids: &[i32],
) -> sqlx::Result<HashMap<i32, Option<String>>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        "SELECT id, subject, subject_iv, subject_encrypted FROM emails WHERE id = ANY($1)",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.get::<i32, _>("id"), read_subject(&r)))
        .collect())
}

// ─────────────────────────────────────────────────────────────────────
// Read: attachments for a user, with email metadata denormalised
// ─────────────────────────────────────────────────────────────────────

pub struct AttachmentRow {
    pub id: i32,
    pub email_id: i32,
    pub filename: String,
    pub mime_type: Option<String>,
    pub size: Option<i64>,
    pub created_at: Option<NaiveDateTime>,
    pub subject: Option<String>,
    pub sender: Option<String>,
    pub receiver: Option<String>,
}

pub async fn list_attachments_for_user(
    pool: &PgPool,
    user_id: i32,
) -> sqlx::Result<Vec<AttachmentRow>> {
    let rows = sqlx::query(
        r#"
        SELECT ea.id, ea.email_id, ea.filename, ea.mime_type, ea.size,
               ea.created_at, e.subject, e.subject_iv, e.subject_encrypted,
               e.sender, e.receiver
          FROM email_attachments ea
          JOIN emails e ON ea.email_id = e.id
          JOIN email_accounts a ON ea.account_id = a.id
         WHERE a.user_id = $1
         ORDER BY ea.created_at DESC, ea.id DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| AttachmentRow {
            id: r.get::<i32, _>("id"),
            email_id: r.get::<i32, _>("email_id"),
            filename: r.get::<String, _>("filename"),
            mime_type: r.try_get::<Option<String>, _>("mime_type").ok().flatten(),
            size: r.try_get::<Option<i64>, _>("size").ok().flatten(),
            created_at: r.try_get("created_at").ok(),
            subject: read_subject(&r),
            sender: r.try_get::<Option<String>, _>("sender").ok().flatten(),
            receiver: r.try_get::<Option<String>, _>("receiver").ok().flatten(),
        })
        .collect())
}

// ─────────────────────────────────────────────────────────────────────
// Write: batch upsert (Gmail sync path)
// ─────────────────────────────────────────────────────────────────────

pub struct InsertEmail<'a> {
    pub gmail_id: &'a str,
    pub sender: &'a str,
    pub receiver: &'a str,
    pub subject: &'a str,
    pub created_at: NaiveDateTime,
    pub is_read: bool,
    pub labels: &'a [String],
    /// `None` defers body to body_worker (sync.rs). `Some(iv, ciphertext)`
    /// writes the body inline (outlook.rs already has the full payload).
    pub body: Option<(&'a str, &'a str)>,
    /// Outlook flips this to `true` because the full Graph response already
    /// contains attachments; Gmail leaves it `false` so body_worker re-checks.
    pub attachments_checked: bool,
}

pub struct InsertResult {
    pub id: i32,
    pub sender: Option<String>,
    pub subject: Option<String>,
    pub created_at: Option<NaiveDateTime>,
    /// True iff this was a fresh INSERT (xmax = 0). False on ON CONFLICT UPDATE.
    /// Used by sync.rs to fire `email.received` exactly once per new message.
    pub is_new: bool,
}

pub async fn upsert_batch(
    pool: &PgPool,
    account_id: i32,
    batch: &[InsertEmail<'_>],
) -> sqlx::Result<Vec<InsertResult>> {
    if batch.is_empty() {
        return Ok(Vec::new());
    }

    // Columns per row: gmail_id, sender, receiver, subject_iv,
    // subject_encrypted, created_at, body_encrypted, body_iv, account_id,
    // is_read, labels, attachments_checked = 12.
    let placeholders_per_row = 12;
    let mut query = String::from(
        "INSERT INTO emails(gmail_id, sender, receiver, subject_iv, subject_encrypted, \
         created_at, body_encrypted, body_iv, account_id, is_read, labels, \
         attachments_checked) VALUES ",
    );
    for (i, _) in batch.iter().enumerate() {
        let base = i * placeholders_per_row;
        query.push('(');
        for col in 0..placeholders_per_row {
            if col > 0 {
                query.push_str(", ");
            }
            query.push('$');
            query.push_str(&(base + col + 1).to_string());
        }
        query.push_str("),");
    }
    query.pop();
    // ON CONFLICT also nulls the legacy `subject` so a re-sync of an
    // already-backfilled row can't accidentally re-leak plaintext.
    query.push_str(
        " ON CONFLICT (account_id, gmail_id) DO UPDATE SET \
         sender = EXCLUDED.sender, \
         receiver = EXCLUDED.receiver, \
         subject_iv = EXCLUDED.subject_iv, \
         subject_encrypted = EXCLUDED.subject_encrypted, \
         subject = NULL, \
         created_at = EXCLUDED.created_at, \
         is_read = EXCLUDED.is_read, \
         labels = EXCLUDED.labels \
         RETURNING id, sender, subject, subject_iv, subject_encrypted, created_at, (xmax = 0) AS is_new",
    );

    let mut q = sqlx::query(&query);
    let mut subject_envelopes: Vec<(String, String)> = Vec::with_capacity(batch.len());
    for row in batch {
        subject_envelopes.push(encrypt_subject_for_storage(row.subject));
    }
    for (row, (subject_iv, subject_encrypted)) in batch.iter().zip(subject_envelopes.iter()) {
        let (body_iv, body_encrypted) = row.body.unwrap_or(("", ""));
        q = q
            .bind(row.gmail_id)
            .bind(row.sender)
            .bind(row.receiver)
            .bind(subject_iv.as_str())
            .bind(subject_encrypted.as_str())
            .bind(row.created_at)
            .bind(body_encrypted)
            .bind(body_iv)
            .bind(account_id)
            .bind(row.is_read)
            .bind(row.labels)
            .bind(row.attachments_checked);
    }
    let returned = q.fetch_all(pool).await?;
    Ok(returned
        .into_iter()
        .map(|r| InsertResult {
            id: r.try_get("id").unwrap_or(0),
            sender: r.try_get::<Option<String>, _>("sender").ok().flatten(),
            subject: read_subject(&r),
            created_at: r.try_get("created_at").ok(),
            is_new: r.try_get::<bool, _>("is_new").unwrap_or(false),
        })
        .collect())
}

// ─────────────────────────────────────────────────────────────────────
// Write: single-row upsert (Outlook path)
// ─────────────────────────────────────────────────────────────────────
//
// Outlook supplies the body inline, sets attachments_checked = true, and
// only needs the id back to attach the attachments sub-resource.

pub async fn upsert_one(
    pool: &PgPool,
    account_id: i32,
    row: &InsertEmail<'_>,
) -> sqlx::Result<i32> {
    let (body_iv, body_encrypted) = row.body.unwrap_or(("", ""));
    let (subject_iv, subject_encrypted) = encrypt_subject_for_storage(row.subject);
    let returned = sqlx::query(
        r#"
        INSERT INTO emails
          (gmail_id, sender, receiver, subject_iv, subject_encrypted, created_at,
           body_encrypted, body_iv, account_id, attachments_checked, is_read, labels)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (account_id, gmail_id) DO UPDATE SET
          sender = EXCLUDED.sender,
          receiver = EXCLUDED.receiver,
          subject_iv = EXCLUDED.subject_iv,
          subject_encrypted = EXCLUDED.subject_encrypted,
          subject = NULL,
          created_at = EXCLUDED.created_at,
          body_encrypted = EXCLUDED.body_encrypted,
          body_iv = EXCLUDED.body_iv,
          is_read = EXCLUDED.is_read,
          labels = EXCLUDED.labels
        RETURNING id
        "#,
    )
    .bind(row.gmail_id)
    .bind(row.sender)
    .bind(row.receiver)
    .bind(&subject_iv)
    .bind(&subject_encrypted)
    .bind(row.created_at)
    .bind(body_encrypted)
    .bind(body_iv)
    .bind(account_id)
    .bind(row.attachments_checked)
    .bind(row.is_read)
    .bind(row.labels)
    .fetch_one(pool)
    .await?;
    Ok(returned.get::<i32, _>("id"))
}

/// One-time encryption migration: walks legacy plaintext-only rows in
/// capped batches, encrypts the `subject` into the new envelope columns,
/// and nulls the plaintext. Idempotent — the WHERE skips rows already
/// migrated. Called from `main` on every startup; safe to re-run.
pub async fn backfill_subjects(pool: &PgPool) -> sqlx::Result<u64> {
    const BATCH: i64 = 500;
    let mut total: u64 = 0;
    loop {
        let rows = sqlx::query(
            "SELECT id, subject FROM emails \
             WHERE subject IS NOT NULL \
               AND subject <> '' \
               AND (subject_encrypted IS NULL OR subject_encrypted = '') \
             LIMIT $1",
        )
        .bind(BATCH)
        .fetch_all(pool)
        .await?;
        if rows.is_empty() {
            return Ok(total);
        }
        let count = rows.len() as u64;
        for row in rows {
            let id: i32 = match row.try_get("id") {
                Ok(id) => id,
                Err(_) => continue,
            };
            let plain: String = match row.try_get("subject") {
                Ok(s) => s,
                Err(_) => continue,
            };
            let (iv, encrypted) = encrypt_subject_for_storage(&plain);
            if iv.is_empty() || encrypted.is_empty() {
                continue;
            }
            let _ = sqlx::query(
                "UPDATE emails SET subject_iv = $1, subject_encrypted = $2, subject = NULL WHERE id = $3",
            )
            .bind(&iv)
            .bind(&encrypted)
            .bind(id)
            .execute(pool)
            .await;
        }
        total += count;
        if (count as i64) < BATCH {
            return Ok(total);
        }
    }
}
