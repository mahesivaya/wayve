//! Single source of truth for every read/write against the `emails` table. It
//! owns SELECT projections, INSERT shapes, and at-rest crypto, so adding or
//! encrypting a column is a one-file change.
//!
//! Body encryption stays in `body_handlers`, because that path also refetches
//! from Gmail when the local row is empty and would drag a Gmail client
//! dependency in here. The repo exposes the raw `body_iv` / `body_encrypted` /
//! `attachments_checked` columns for it.

use chrono::NaiveDateTime;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, QueryBuilder, Row};
use std::collections::HashMap;

// Subject/address crypto seam, AES-256-GCM at rest in the same envelope as
// body_*. Reads prefer the encrypted pair and fall back to the legacy plaintext
// column on pre-backfill rows. Writes null the plaintext subject column, so a
// stale plaintext can't outlive a write that touches the row.

/// Encrypts a subject for storage as `(subject_iv, subject_encrypted)`.
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

/// Encrypts an email address for storage as `(iv, ciphertext, hash)`. The hash
/// is a keyed HMAC of the trimmed, lowercased address and is the only way to
/// compare addresses for equality, since the ciphertext is randomized. Empty
/// input returns three empty strings, stored as NULLs.
fn encrypt_address_for_storage(addr: &str) -> (String, String, String) {
    if addr.is_empty() {
        return (String::new(), String::new(), String::new());
    }
    let (iv, ciphertext) = wayve_security::encryption::encrypt(addr).unwrap_or_default();
    let hash = wayve_security::encryption::compute_address_hash(addr)
        .ok()
        .flatten()
        .unwrap_or_default();
    (iv, ciphertext, hash)
}

/// Decodes `sender_encrypted` + `sender_iv`, falling back to the legacy
/// plaintext `sender` column for rows that haven't been backfilled yet.
fn read_sender(row: &PgRow) -> Option<String> {
    let enc: Option<String> = row.try_get("sender_encrypted").ok().flatten();
    let iv: Option<String> = row.try_get("sender_iv").ok().flatten();
    if let (Some(e), Some(i)) = (enc.as_deref(), iv.as_deref())
        && !e.is_empty()
        && !i.is_empty()
        && let Ok(plain) = wayve_security::encryption::decrypt(i, e)
    {
        return Some(plain);
    }
    row.try_get::<Option<String>, _>("sender").ok().flatten()
}

fn read_receiver(row: &PgRow) -> Option<String> {
    let enc: Option<String> = row.try_get("receiver_encrypted").ok().flatten();
    let iv: Option<String> = row.try_get("receiver_iv").ok().flatten();
    if let (Some(e), Some(i)) = (enc.as_deref(), iv.as_deref())
        && !e.is_empty()
        && !i.is_empty()
        && let Ok(plain) = wayve_security::encryption::decrypt(i, e)
    {
        return Some(plain);
    }
    row.try_get::<Option<String>, _>("receiver").ok().flatten()
}

/// One row in the inbox/folder list. The shared-inbox fields collapse to
/// `is_shared = false` and `None` for a personal mailbox, whose LEFT JOINs miss.
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

#[derive(Clone)]
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
    // Fetch page_size + 1 so the caller can compute `has_more` without a COUNT.
    let query_limit = (filters.page_size + 1) as i64;

    // The LEFT JOIN on `email_accounts` keeps Wayve-to-Wayve rows (NULL
    // account_id) in the result. The tenant boundary is the WHERE clause: a row
    // belongs to the caller via their email_account, via shared-inbox
    // membership, or via being a Wayve-to-Wayve delivery addressed to them.
    let mut qb = QueryBuilder::new(
        r#"
        SELECT e.id, e.gmail_id, e.subject, e.subject_iv, e.subject_encrypted,
               e.sender, e.receiver,
               e.sender_iv, e.sender_encrypted, e.receiver_iv, e.receiver_encrypted,
               (e.body_encrypted <> '') AS has_body,
               EXISTS (
                   SELECT 1 FROM email_attachments ea WHERE ea.email_id = e.id
               ) AS has_attachments,
               e.account_id, e.is_read, e.created_at,
               COALESCE(a.is_shared, FALSE) AS is_shared,
               a.shared_label,
               s.status AS inbox_status, s.assignee_id AS inbox_assignee_id
        FROM emails e
        LEFT JOIN email_accounts a ON e.account_id = a.id
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
    qb.push(" OR sm.user_id IS NOT NULL OR (e.source = 'wayve' AND e.recipient_user_id = ");
    qb.push_bind(filters.user_id);
    qb.push("))");

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
            // Wayve-source rows have a NULL account_id, so the legacy
            // "sender isn't me" heuristic can't apply; send_internal tags them
            // with explicit INBOX/SENT labels instead. Route those by label and
            // keep the heuristic as a fallback for label-less provider rows.
            "inbox" => {
                qb.push(
                    " AND (\
                       (e.source = 'wayve' AND 'INBOX' = ANY(e.labels)) \
                       OR (e.source <> 'wayve' \
                           AND a.email IS NOT NULL \
                           AND NOT ('SPAM' = ANY(e.labels)) AND NOT ('DRAFT' = ANY(e.labels)) \
                           AND NOT ('TRASH' = ANY(e.labels)) \
                           AND ('INBOX' = ANY(e.labels) \
                                OR lower(coalesce(e.sender, '')) NOT LIKE '%' || lower(a.email) || '%'))) ",
                );
                // Marked-noise senders are moved out of the inbox.
                qb.push(
                    " AND NOT EXISTS (SELECT 1 FROM noise_senders ns \
                       WHERE ns.user_id = ",
                );
                qb.push_bind(filters.user_id);
                qb.push(
                    " AND lower(coalesce(e.sender, '')) LIKE '%' || lower(ns.sender_email) || '%') ",
                );
            }
            "sent" => {
                qb.push(
                    " AND (\
                       (e.source = 'wayve' AND 'SENT' = ANY(e.labels)) \
                       OR (e.source <> 'wayve' \
                           AND ('SENT' = ANY(e.labels) \
                                OR (a.email IS NOT NULL \
                                    AND lower(coalesce(e.sender, '')) LIKE '%' || lower(a.email) || '%')))) ",
                );
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
            "trash" => {
                qb.push(" AND 'TRASH' = ANY(e.labels) ");
            }
            // "GitHub" is a virtual, sender-based folder rather than a Gmail
            // label, so it cross-cuts accounts like a saved `from:github.com`
            // search. It relies on the plaintext `sender` column, which sync
            // still populates; only `subject` is nulled.
            "github" => {
                qb.push(" AND lower(coalesce(e.sender, '')) LIKE '%github.com%' ");
            }
            // Inbox sub-views (the "All / Signal / Noise" chips): "signal" is the
            // high-priority mail — anything Gmail tags Important OR Updates —
            // minus senders the user marked as Noise. "noise" bundles the
            // low-priority categories (social + promotions) plus marked senders.
            "signal" => {
                qb.push(
                    " AND ('IMPORTANT' = ANY(e.labels) \
                       OR 'CATEGORY_UPDATES' = ANY(e.labels)) \
                       AND NOT EXISTS (SELECT 1 FROM noise_senders ns \
                          WHERE ns.user_id = ",
                );
                qb.push_bind(filters.user_id);
                qb.push(
                    " AND lower(coalesce(e.sender, '')) LIKE '%' || lower(ns.sender_email) || '%') ",
                );
            }
            "noise" => {
                // A sender the user marked as Noise ALWAYS lands here — even if
                // Gmail tagged the mail Important/Updates — so noise-marking
                // overrides Signal. Otherwise, the low-priority categories
                // (social + promotions) that Signal doesn't claim. The
                // NOT IMPORTANT / NOT CATEGORY_UPDATES guards keep Signal and
                // Noise disjoint for mail Gmail double-tags.
                qb.push(
                    " AND (EXISTS (SELECT 1 FROM noise_senders ns \
                          WHERE ns.user_id = ",
                );
                qb.push_bind(filters.user_id);
                qb.push(
                    " AND lower(coalesce(e.sender, '')) LIKE '%' || lower(ns.sender_email) || '%') \
                       OR (NOT ('IMPORTANT' = ANY(e.labels)) \
                           AND NOT ('CATEGORY_UPDATES' = ANY(e.labels)) \
                           AND ('CATEGORY_SOCIAL' = ANY(e.labels) \
                                OR 'CATEGORY_PROMOTIONS' = ANY(e.labels)))) ",
                );
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
        // Subject is encrypted at rest, so `LIKE` only matches the legacy
        // plaintext column on not-yet-backfilled rows. Once backfill completes
        // the subject clause is a no-op and subject search must move
        // client-side, onto the decrypted page.
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

    // `emails` is RLS-enabled, so the read runs under the restricted role with
    // the caller's GUC and the row policy engages as defense in depth behind the
    // WHERE clause. Inlined rather than calling db::apply_rls_user because this
    // fn returns sqlx::Result. `user_id` is an i32, so there is no injection
    // surface in the formatted statement below.
    let mut tx = pool.begin().await?;
    let uid = filters.user_id;
    sqlx::raw_sql(&format!(
        "SELECT set_config('app.user_id', '{uid}', true); SET LOCAL ROLE wayve_app;"
    ))
    .execute(&mut *tx)
    .await?;
    let raw = qb.build().fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(raw.into_iter().map(map_list_row).collect())
}

fn map_list_row(row: PgRow) -> EmailListRow {
    EmailListRow {
        id: row.get::<i32, _>("id"),
        gmail_id: row.get::<String, _>("gmail_id"),
        account_id: row.try_get::<Option<i32>, _>("account_id").ok().flatten(),
        subject: read_subject(&row),
        sender: read_sender(&row),
        receiver: read_receiver(&row),
        has_body: row.try_get::<bool, _>("has_body").unwrap_or(false),
        has_attachments: row.try_get::<bool, _>("has_attachments").unwrap_or(false),
        is_read: row
            .try_get::<Option<bool>, _>("is_read")
            .ok()
            .flatten()
            .unwrap_or(true),
        created_at: row.try_get("created_at").ok(),
        is_shared: row.try_get::<bool, _>("is_shared").unwrap_or(false),
        shared_label: row
            .try_get::<Option<String>, _>("shared_label")
            .ok()
            .flatten(),
        inbox_status: row
            .try_get::<Option<String>, _>("inbox_status")
            .ok()
            .flatten(),
        inbox_assignee_id: row
            .try_get::<Option<i32>, _>("inbox_assignee_id")
            .ok()
            .flatten(),
    }
}

/// Single-row read for the `/emails/{id}` detail endpoint. The body stays as
/// the raw envelope (iv + ciphertext) so the caller can decrypt and cache it.
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
    // Same LEFT JOIN and wayve-source recipient clause as the list query, so
    // opening a Wayve-to-Wayve email by id works despite its NULL account_id.
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.user_id', $1, true)")
        .bind(user_id.to_string())
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL ROLE wayve_app")
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query(
        r#"
        SELECT e.id, e.account_id, e.subject, e.subject_iv, e.subject_encrypted,
               e.sender, e.receiver,
               e.sender_iv, e.sender_encrypted, e.receiver_iv, e.receiver_encrypted,
               e.body_encrypted, e.body_iv, e.attachments_checked
          FROM emails e
          LEFT JOIN email_accounts a ON e.account_id = a.id
          LEFT JOIN shared_inbox_members m
                 ON m.account_id = a.id AND m.user_id = $2
         WHERE e.id = $1
           AND (a.user_id = $2
                OR m.user_id IS NOT NULL
                OR (e.source = 'wayve' AND e.recipient_user_id = $2))
        "#,
    )
    .bind(email_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(row.map(|r| EmailDetailRow {
        id: r.get::<i32, _>("id"),
        account_id: r.try_get::<Option<i32>, _>("account_id").ok().flatten(),
        subject: read_subject(&r),
        sender: read_sender(&r),
        receiver: read_receiver(&r),
        body_iv: r
            .try_get::<Option<String>, _>("body_iv")
            .ok()
            .flatten()
            .unwrap_or_default(),
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

/// Subjects for a list of email ids, used by the admin and inbox-queue views.
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

/// An attachment with its parent email's metadata denormalised onto it.
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
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.user_id', $1, true)")
        .bind(user_id.to_string())
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL ROLE wayve_app")
        .execute(&mut *tx)
        .await?;
    let rows = sqlx::query(
        r#"
        SELECT ea.id, ea.email_id, ea.filename, ea.mime_type, ea.size,
               ea.created_at, e.subject, e.subject_iv, e.subject_encrypted,
               e.sender, e.receiver,
               e.sender_iv, e.sender_encrypted, e.receiver_iv, e.receiver_encrypted
          FROM email_attachments ea
          JOIN emails e ON ea.email_id = e.id
          JOIN email_accounts a ON ea.account_id = a.id
         WHERE a.user_id = $1
         ORDER BY ea.created_at DESC, ea.id DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

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
            sender: read_sender(&r),
            receiver: read_receiver(&r),
        })
        .collect())
}

pub struct InsertEmail<'a> {
    pub gmail_id: &'a str,
    pub sender: &'a str,
    pub receiver: &'a str,
    pub subject: &'a str,
    pub created_at: NaiveDateTime,
    pub is_read: bool,
    pub labels: &'a [String],
    /// `None` leaves `body_encrypted = ''`, which is body_worker's pending
    /// marker. `Some((iv, ciphertext))` writes the body inline, as Outlook does.
    pub body: Option<(&'a str, &'a str)>,
    /// Outlook sets this true because the Graph response already contains
    /// attachments; Gmail leaves it false so body_worker re-checks.
    pub attachments_checked: bool,
}

pub struct InsertResult {
    pub id: i32,
    /// Provider message id (Gmail message id, Outlook id, or IMAP uid). Used as
    /// the message id in the `email_received` audit event.
    pub gmail_id: String,
    pub sender: Option<String>,
    pub subject: Option<String>,
    pub created_at: Option<NaiveDateTime>,
    /// True only for a fresh INSERT (xmax = 0), false on ON CONFLICT UPDATE, so
    /// sync.rs fires `email.received` exactly once per new message.
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

    // Must equal the column count in the INSERT list below. The legacy
    // plaintext sender/receiver are still written so readers that fall back to
    // them on pre-backfill rows keep working.
    let placeholders_per_row = 18;
    let mut query = String::from(
        "INSERT INTO emails(gmail_id, sender, receiver, subject_iv, subject_encrypted, \
         created_at, body_encrypted, body_iv, account_id, is_read, labels, \
         attachments_checked, sender_iv, sender_encrypted, sender_hash, \
         receiver_iv, receiver_encrypted, receiver_hash) VALUES ",
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
    // ON CONFLICT nulls the legacy `subject` so re-syncing an already-backfilled
    // row can't re-leak plaintext. `is_read` is deliberately monotonic: sync
    // re-fetches the last hour every tick and the mark-read push to Gmail lags,
    // so a plain assignment would flip just-opened mail back to unread. The
    // trade-off is that mail re-marked unread in Gmail stays read here.
    query.push_str(
        " ON CONFLICT (account_id, gmail_id) DO UPDATE SET \
         sender = EXCLUDED.sender, \
         receiver = EXCLUDED.receiver, \
         subject_iv = EXCLUDED.subject_iv, \
         subject_encrypted = EXCLUDED.subject_encrypted, \
         subject = NULL, \
         sender_iv = EXCLUDED.sender_iv, \
         sender_encrypted = EXCLUDED.sender_encrypted, \
         sender_hash = EXCLUDED.sender_hash, \
         receiver_iv = EXCLUDED.receiver_iv, \
         receiver_encrypted = EXCLUDED.receiver_encrypted, \
         receiver_hash = EXCLUDED.receiver_hash, \
         created_at = EXCLUDED.created_at, \
         is_read = emails.is_read OR EXCLUDED.is_read, \
         labels = EXCLUDED.labels \
         RETURNING id, gmail_id, sender, subject, subject_iv, subject_encrypted, \
         sender_iv, sender_encrypted, receiver_iv, receiver_encrypted, \
         created_at, (xmax = 0) AS is_new",
    );

    let mut q = sqlx::query(&query);
    let mut subject_envelopes: Vec<(String, String)> = Vec::with_capacity(batch.len());
    let mut sender_envelopes: Vec<(String, String, String)> = Vec::with_capacity(batch.len());
    let mut receiver_envelopes: Vec<(String, String, String)> = Vec::with_capacity(batch.len());
    for row in batch {
        subject_envelopes.push(encrypt_subject_for_storage(row.subject));
        sender_envelopes.push(encrypt_address_for_storage(row.sender));
        receiver_envelopes.push(encrypt_address_for_storage(row.receiver));
    }
    for ((row, (subject_iv, subject_encrypted)), ((s_iv, s_ct, s_hash), (r_iv, r_ct, r_hash))) in
        batch
            .iter()
            .zip(subject_envelopes.iter())
            .zip(sender_envelopes.iter().zip(receiver_envelopes.iter()))
    {
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
            .bind(row.attachments_checked)
            .bind(s_iv.as_str())
            .bind(s_ct.as_str())
            .bind(s_hash.as_str())
            .bind(r_iv.as_str())
            .bind(r_ct.as_str())
            .bind(r_hash.as_str());
    }
    let returned = q.fetch_all(pool).await?;
    let results: Vec<InsertResult> = returned
        .into_iter()
        .map(|r| InsertResult {
            id: r.try_get("id").unwrap_or(0),
            gmail_id: r.try_get("gmail_id").unwrap_or_default(),
            sender: read_sender(&r),
            subject: read_subject(&r),
            created_at: r.try_get("created_at").ok(),
            is_new: r.try_get::<bool, _>("is_new").unwrap_or(false),
        })
        .collect();

    stamp_last_message_at(pool, account_id, &results).await;

    Ok(results)
}

/// Advances the account's freshness signal to the newest genuinely-new row's
/// timestamp. Only `is_new` rows count, and GREATEST + COALESCE stops a
/// late-arriving older message (a backfill page) rolling the clock backwards.
async fn stamp_last_message_at(pool: &PgPool, account_id: i32, results: &[InsertResult]) {
    let Some(max_new) = results
        .iter()
        .filter(|r| r.is_new)
        .filter_map(|r| r.created_at)
        .max()
    else {
        return;
    };
    if let Err(err) = sqlx::query(
        "UPDATE email_accounts \
         SET last_message_at = GREATEST(COALESCE(last_message_at, $1), $1) \
         WHERE id = $2",
    )
    .bind(max_new)
    .bind(account_id)
    .execute(pool)
    .await
    {
        // Best-effort: a failed stamp only makes the next sync cycle treat this
        // account as quieter than it is, and the email row already landed.
        tracing::warn!(
            target: "worker",
            account_id,
            error = ?err,
            "failed to stamp last_message_at after upsert"
        );
    }
}

/// Single-row upsert for the Outlook path, which supplies the body inline, sets
/// `attachments_checked = true`, and needs only the id back to attach the
/// attachments sub-resource.
pub async fn upsert_one(
    pool: &PgPool,
    account_id: i32,
    row: &InsertEmail<'_>,
) -> sqlx::Result<i32> {
    let (body_iv, body_encrypted) = row.body.unwrap_or(("", ""));
    let (subject_iv, subject_encrypted) = encrypt_subject_for_storage(row.subject);
    let (sender_iv, sender_encrypted, sender_hash) = encrypt_address_for_storage(row.sender);
    let (receiver_iv, receiver_encrypted, receiver_hash) =
        encrypt_address_for_storage(row.receiver);
    // `(xmax = 0) AS is_new` distinguishes a genuinely new row from an
    // ON CONFLICT re-sync, so only the former stamps last_message_at.
    let returned = sqlx::query(
        r#"
        INSERT INTO emails
          (gmail_id, sender, receiver, subject_iv, subject_encrypted, created_at,
           body_encrypted, body_iv, account_id, attachments_checked, is_read, labels,
           sender_iv, sender_encrypted, sender_hash,
           receiver_iv, receiver_encrypted, receiver_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17, $18)
        ON CONFLICT (account_id, gmail_id) DO UPDATE SET
          sender = EXCLUDED.sender,
          receiver = EXCLUDED.receiver,
          subject_iv = EXCLUDED.subject_iv,
          subject_encrypted = EXCLUDED.subject_encrypted,
          subject = NULL,
          sender_iv = EXCLUDED.sender_iv,
          sender_encrypted = EXCLUDED.sender_encrypted,
          sender_hash = EXCLUDED.sender_hash,
          receiver_iv = EXCLUDED.receiver_iv,
          receiver_encrypted = EXCLUDED.receiver_encrypted,
          receiver_hash = EXCLUDED.receiver_hash,
          created_at = EXCLUDED.created_at,
          body_encrypted = EXCLUDED.body_encrypted,
          body_iv = EXCLUDED.body_iv,
          is_read = emails.is_read OR EXCLUDED.is_read,
          labels = EXCLUDED.labels
        RETURNING id, (xmax = 0) AS is_new, created_at
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
    .bind(&sender_iv)
    .bind(&sender_encrypted)
    .bind(&sender_hash)
    .bind(&receiver_iv)
    .bind(&receiver_encrypted)
    .bind(&receiver_hash)
    .fetch_one(pool)
    .await?;

    let id: i32 = returned.get("id");
    let result = InsertResult {
        id,
        gmail_id: row.gmail_id.to_string(),
        sender: None,
        subject: None,
        created_at: returned.try_get("created_at").ok(),
        is_new: returned.try_get::<bool, _>("is_new").unwrap_or(false),
    };
    stamp_last_message_at(pool, account_id, std::slice::from_ref(&result)).await;

    Ok(id)
}

/// Encrypts the `subject` of legacy plaintext-only rows into the envelope
/// columns and nulls the plaintext, in capped batches. Runs on every startup;
/// idempotent, because the WHERE skips already-migrated rows.
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

/// Encryption and hashing migration for the sender/receiver columns, mirroring
/// `backfill_subjects`. The plaintext columns are deliberately left in place
/// until the encrypted-first read path is proven on real traffic. Idempotent.
pub async fn backfill_addresses(pool: &PgPool) -> sqlx::Result<u64> {
    const BATCH: i64 = 500;
    let mut total: u64 = 0;
    loop {
        let rows = sqlx::query(
            "SELECT id, sender, receiver FROM emails \
             WHERE ((sender IS NOT NULL AND sender <> '' \
                    AND (sender_encrypted IS NULL OR sender_encrypted = '')) \
                 OR (receiver IS NOT NULL AND receiver <> '' \
                    AND (receiver_encrypted IS NULL OR receiver_encrypted = ''))) \
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
            let sender_plain: Option<String> = row.try_get("sender").ok();
            let receiver_plain: Option<String> = row.try_get("receiver").ok();

            let (s_iv, s_ct, s_hash) =
                encrypt_address_for_storage(sender_plain.as_deref().unwrap_or(""));
            let (r_iv, r_ct, r_hash) =
                encrypt_address_for_storage(receiver_plain.as_deref().unwrap_or(""));

            // NULLIF leaves empty columns NULL, which keeps the WHERE above
            // selective: once a row has both filled it stops matching.
            let _ = sqlx::query(
                "UPDATE emails SET \
                   sender_iv = NULLIF($1, ''), \
                   sender_encrypted = NULLIF($2, ''), \
                   sender_hash = NULLIF($3, ''), \
                   receiver_iv = NULLIF($4, ''), \
                   receiver_encrypted = NULLIF($5, ''), \
                   receiver_hash = NULLIF($6, '') \
                 WHERE id = $7",
            )
            .bind(&s_iv)
            .bind(&s_ct)
            .bind(&s_hash)
            .bind(&r_iv)
            .bind(&r_ct)
            .bind(&r_hash)
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
