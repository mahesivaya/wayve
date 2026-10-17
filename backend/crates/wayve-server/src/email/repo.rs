//! Single source of truth for every read/write against the `emails` table. It
//! owns SELECT projections, INSERT shapes, and at-rest crypto, so adding or
//! encrypting a column is a one-file change.
//!
//! Body encryption stays in `body_handlers`, because that path also refetches
//! from Gmail when the local row is empty and would drag a Gmail client
//! dependency in here. The repo exposes the raw `body_iv` / `body_encrypted` /
//! `attachments_checked` columns for it.

use chrono::NaiveDateTime;
use serde::Serialize;
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

/// `(cc_iv, cc_encrypted)` for storage: both NULL when the Cc isn't known (so an
/// upsert keeps the stored value), both empty when there is none.
fn encrypt_cc_for_storage(cc: Option<&str>) -> (Option<String>, Option<String>) {
    match cc.map(str::trim) {
        None => (None, None),
        Some("") => (Some(String::new()), Some(String::new())),
        Some(value) => match wayve_security::encryption::encrypt(value) {
            Ok((iv, ciphertext)) => (Some(iv), Some(ciphertext)),
            // Unknown rather than empty, so a later sync or the backfill retries.
            Err(_) => (None, None),
        },
    }
}

/// Records the Cc header of an already-stored message (`""` for none), for the
/// paths that re-read a message's headers after it was stored.
pub(crate) async fn set_cc(
    pool: &PgPool,
    account_id: i32,
    gmail_id: &str,
    cc: &str,
) -> sqlx::Result<()> {
    let (cc_iv, cc_encrypted) = encrypt_cc_for_storage(Some(cc));
    sqlx::query(
        "UPDATE emails SET cc_iv = $1, cc_encrypted = $2 \
         WHERE account_id = $3 AND gmail_id = $4",
    )
    .bind(cc_iv)
    .bind(cc_encrypted)
    .bind(account_id)
    .bind(gmail_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Decodes the Cc envelope. `None` while it isn't known yet; `Some("")` when the
/// message had no Cc.
fn read_cc(row: &PgRow) -> Option<String> {
    let enc: Option<String> = row.try_get("cc_encrypted").ok().flatten();
    let iv: Option<String> = row.try_get("cc_iv").ok().flatten();
    match (enc.as_deref(), iv.as_deref()) {
        (Some(""), _) | (_, Some("")) => Some(String::new()),
        (Some(e), Some(i)) => wayve_security::encryption::decrypt(i, e).ok(),
        _ => None,
    }
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
    /// Starred (Gmail's STARRED label). A conversation row is starred while
    /// any of its messages is, as in Gmail.
    pub is_starred: bool,
    pub created_at: Option<NaiveDateTime>,
    /// UTC. Set while snoozed, and kept once the snooze has passed, so `sort_at`
    /// can put returned mail at the top.
    pub snoozed_until: Option<NaiveDateTime>,
    /// The list's order and paging cursor (see `ListOrder`): `created_at`, a
    /// snooze's end in the inbox views once it has passed, or in Snoozed when
    /// it comes back. For a conversation, the latest of its messages'.
    pub sort_at: Option<NaiveDateTime>,
    pub is_shared: bool,
    pub shared_label: Option<String>,
    pub inbox_status: Option<String>,
    pub inbox_assignee_id: Option<i32>,
    /// Conversation fields, set only on a grouped list (`group_threads`).
    pub thread_id: Option<i32>,
    pub message_count: Option<i64>,
    pub unread_count: Option<i64>,
    pub message_ids: Option<Vec<i32>>,
    /// The conversation's unread messages, so marking it read touches only
    /// those (each read also goes to the provider).
    pub unread_ids: Option<Vec<i32>>,
    /// The conversation's starred messages, so unstarring it clears them all.
    pub starred_ids: Option<Vec<i32>>,
    /// Everyone who wrote in the conversation, once each, in order of their
    /// first message. The client shows your own addresses as "me" and the
    /// unread ones in bold.
    pub participants: Option<Vec<Participant>>,
}

/// One person in a conversation row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Participant {
    /// Their sender header ("Ayana <a@x.com>").
    pub sender: String,
    /// Whether any of their messages in the conversation is unread.
    pub unread: bool,
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
    /// One row per conversation instead of per email (not for spam, drafts or
    /// trash). Off by default, so existing callers keep per-email rows.
    pub group_threads: bool,
}

/// Projection shared by the per-email list, the grouped (conversation) list and
/// the conversation reader, so all three decrypt rows the same way
/// (`map_list_row`).
const LIST_COLUMNS: &str = r#"
        e.id, e.gmail_id, e.subject, e.subject_iv, e.subject_encrypted,
        e.sender, e.receiver,
        e.sender_iv, e.sender_encrypted, e.receiver_iv, e.receiver_encrypted,
        (e.body_encrypted <> '') AS has_body,
        EXISTS (
            SELECT 1 FROM email_attachments ea WHERE ea.email_id = e.id
        ) AS has_attachments,
        e.account_id, e.is_read, e.created_at,
        ('STARRED' = ANY(e.labels)) AS is_starred,
        e.snoozed_until,
        COALESCE(a.is_shared, FALSE) AS is_shared,
        a.shared_label,
        s.status AS inbox_status, s.assignee_id AS inbox_assignee_id
"#;

/// A conversation's grouping key: its thread, or the email itself while it has
/// none (not yet backfilled, or threading failed), so it stays its own row.
const CONV_KEY: &str = "COALESCE(e.thread_id, -e.id)";

/// A Gmail message is in the inbox only while Gmail labels it INBOX. Sync pulls
/// all mail, archived and filter-skipped included, so "not sent by me" would
/// let those in too. Other providers pass. Reads only `e`, so it also works
/// where the account isn't joined (the grouped Signal/Noise subquery).
const GMAIL_IN_INBOX: &str = "('INBOX' = ANY(e.labels) OR NOT EXISTS (\
     SELECT 1 FROM email_accounts ga WHERE ga.id = e.account_id AND ga.provider = 'google'))";

/// Folders listed one row per conversation when grouping is asked for. Spam,
/// drafts and trash stay per email.
fn folder_groups_threads(folder: Option<&str>) -> bool {
    !matches!(folder, Some("spam" | "drafts" | "trash"))
}

/// `FROM … WHERE <tenant>`: the caller's own mailboxes, shared inboxes they're a
/// member of, and Wayve-to-Wayve mail addressed to them. The LEFT JOIN on
/// `email_accounts` keeps Wayve-to-Wayve rows (NULL account_id).
fn push_scope(qb: &mut QueryBuilder<'_, sqlx::Postgres>, user_id: i32) {
    qb.push(
        r#"
        FROM emails e
        LEFT JOIN email_accounts a ON e.account_id = a.id
        LEFT JOIN shared_inbox_members sm
               ON sm.account_id = a.id AND sm.user_id =
        "#,
    );
    qb.push_bind(user_id);
    qb.push(
        r#"
        LEFT JOIN shared_inbox_email_state s ON s.email_id = e.id
        WHERE (a.user_id =
        "#,
    );
    qb.push_bind(user_id);
    qb.push(" OR sm.user_id IS NOT NULL OR (e.source = 'wayve' AND e.recipient_user_id = ");
    qb.push_bind(user_id);
    qb.push("))");
}

fn push_account_and_status(qb: &mut QueryBuilder<'_, sqlx::Postgres>, filters: &EmailListFilters) {
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
}

/// The current time in the UTC that `snoozed_until` and `created_at` store.
const NOW_UTC: &str = "(now() AT TIME ZONE 'UTC')";

/// A list's order, which is also its paging cursor (`sort_at`, sent with each
/// row). Snooze shapes it only where it hides mail:
/// - the inbox views: when a message arrived, or came back from a snooze if
///   that is later, so returned mail sits at the top as in Gmail. Mail still
///   snoozed is hidden there, so only a snooze that has ended counts.
/// - Snoozed: when each comes back, soonest first.
/// - every other folder: when it arrived. A snoozed email shows there at its
///   own date, not at the future moment it returns.
struct ListOrder {
    /// One row per email. For the inbox views the hidden rows can't reach the
    /// list, so the indexable GREATEST (`idx_emails_account_sort`) is exact.
    per_email: String,
    /// One message within a conversation; the conversation sorts by the
    /// latest of its messages'. Its older messages may still be snoozed (a
    /// reply brought it back), so a snooze counts only once it has ended.
    per_message: String,
    ascending: bool,
}

fn list_order(folder: Option<&str>) -> ListOrder {
    match folder_snooze(folder) {
        Some(SnoozeView::Hide) => ListOrder {
            per_email: "GREATEST(e.created_at, e.snoozed_until)".to_string(),
            per_message: format!(
                "CASE WHEN e.snoozed_until <= {NOW_UTC} \
                 THEN GREATEST(e.created_at, e.snoozed_until) ELSE e.created_at END"
            ),
            ascending: false,
        },
        Some(SnoozeView::Only) => ListOrder {
            per_email: "e.snoozed_until".to_string(),
            per_message: "e.snoozed_until".to_string(),
            ascending: true,
        },
        None => ListOrder {
            per_email: "e.created_at".to_string(),
            per_message: "e.created_at".to_string(),
            ascending: false,
        },
    }
}

impl ListOrder {
    /// `ASC` / `DESC`, and the keyset comparison that pages past a cursor.
    fn direction(&self) -> (&'static str, &'static str) {
        if self.ascending {
            ("ASC", ">")
        } else {
            ("DESC", "<")
        }
    }
}

/// How a folder treats snoozed mail. The inbox views (Inbox, its Signal / Noise
/// chips, Reviews) hide it; Snoozed lists only it; every other folder, All mail
/// included, ignores snooze, so snoozed mail is out of the way but never
/// unreachable.
#[derive(Clone, Copy, PartialEq)]
enum SnoozeView {
    Hide,
    Only,
}

fn folder_snooze(folder: Option<&str>) -> Option<SnoozeView> {
    match folder {
        Some("inbox" | "signal" | "noise" | "github") => Some(SnoozeView::Hide),
        Some("snoozed") => Some(SnoozeView::Only),
        _ => None,
    }
}

/// `per_email`: the list judges each message's own snooze. A conversation
/// list instead judges the whole conversation by its newest message
/// (`push_grouped_list`), as Gmail does: a new reply brings a snoozed
/// conversation back, and an older snoozed message can't keep one in the
/// inbox and in Snoozed at once. Snoozed still narrows a conversation list to
/// those with a snoozed message here, so it never scans every conversation.
fn push_folder(
    qb: &mut QueryBuilder<'_, sqlx::Postgres>,
    filters: &EmailListFilters,
    per_email: bool,
) {
    // Pull-request mail lives exclusively under the "Reviews" folder: the
    // `github` arm selects on this predicate and the inbox tabs (All / Signal /
    // Noise) subtract it, so the two sides stay disjoint and a PR email never
    // shows up in two places.
    //
    // The test is the synthetic label sync stamps on (see
    // `sync::github_pr_label`), not the sender. Sender only says the mail came
    // from GitHub — issues, releases, security alerts and sign-in notices all
    // arrive from the same `notifications@`/`no-reply@` addresses — and the
    // subject can't help because it is encrypted at rest and says `(#123)` for
    // issues and pull requests alike. Narrowing this to PRs means everything
    // else from GitHub now stays in the inbox, which is where it belongs;
    // previously the sender match swallowed all of it into Reviews.
    const GITHUB_PR_MATCH: &str = "'WAYVE_GITHUB_PR' = ANY(e.labels)";

    // Deleted mail keeps its other labels (so a restore puts it back where it
    // was), which would leave it listed under them: only Trash lists it.
    if filters.folder.as_deref() != Some("trash") {
        qb.push(" AND NOT ('TRASH' = ANY(e.labels)) ");
    }
    match folder_snooze(filters.folder.as_deref()) {
        Some(SnoozeView::Hide) if per_email => {
            qb.push(format!(
                " AND (e.snoozed_until IS NULL OR e.snoozed_until <= {NOW_UTC}) "
            ));
        }
        Some(SnoozeView::Only) => {
            qb.push(format!(" AND e.snoozed_until > {NOW_UTC} "));
        }
        _ => {}
    }

    if let Some(folder) = filters.folder.as_deref() {
        match folder {
            // Wayve-source rows have a NULL account_id, so the legacy
            // "sender isn't me" heuristic can't apply; send_internal tags them
            // with explicit INBOX/SENT labels instead. Route those by label and
            // keep the heuristic as a fallback for label-less provider rows.
            // Gmail rows always carry Gmail's own labels, so for them only INBOX
            // counts — see GMAIL_IN_INBOX.
            "inbox" => {
                qb.push(
                    " AND (\
                       (e.source = 'wayve' AND 'INBOX' = ANY(e.labels)) \
                       OR (e.source <> 'wayve' \
                           AND a.email IS NOT NULL \
                           AND NOT ('SPAM' = ANY(e.labels)) AND NOT ('DRAFT' = ANY(e.labels)) \
                           AND NOT ('TRASH' = ANY(e.labels)) \
                           AND ('INBOX' = ANY(e.labels) \
                                OR (a.provider <> 'google' \
                                    AND lower(coalesce(e.sender, '')) NOT LIKE '%' || lower(a.email) || '%')))) ",
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
                // PR/review mail belongs to Reviews, not the inbox.
                qb.push(format!(" AND NOT {GITHUB_PR_MATCH} "));
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
            "starred" => {
                qb.push(" AND 'STARRED' = ANY(e.labels) ");
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
            // "Reviews" is a virtual folder rather than a Gmail label, so it
            // cross-cuts accounts like a saved search. It matches only
            // pull-request notifications — see GITHUB_PR_MATCH above.
            "github" => {
                qb.push(format!(" AND {GITHUB_PR_MATCH} "));
            }
            // Everything except spam, drafts and trash, like Gmail's All Mail:
            // what a search covers, so archived and filter-skipped mail, which
            // no other folder lists, can still be found.
            "all" => {
                qb.push(
                    " AND NOT ('SPAM' = ANY(e.labels)) AND NOT ('DRAFT' = ANY(e.labels)) \
                       AND NOT ('TRASH' = ANY(e.labels)) ",
                );
            }
            // Inbox sub-views (the "All / Signal / Noise" chips): "signal" is the
            // high-priority mail — anything Gmail tags Important OR Updates —
            // minus senders the user marked as Noise. "noise" bundles the
            // low-priority categories (social + promotions) plus marked senders.
            "signal" => {
                qb.push(format!(" AND {GMAIL_IN_INBOX} "));
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
                // PR/review mail belongs to Reviews, not Signal.
                qb.push(format!(" AND NOT {GITHUB_PR_MATCH} "));
            }
            "noise" => {
                // A sender the user marked as Noise ALWAYS lands here — even if
                // Gmail tagged the mail Important/Updates — so noise-marking
                // overrides Signal. Otherwise, the low-priority categories
                // (social + promotions) that Signal doesn't claim. The
                // NOT IMPORTANT / NOT CATEGORY_UPDATES guards keep Signal and
                // Noise disjoint for mail Gmail double-tags.
                qb.push(format!(" AND {GMAIL_IN_INBOX} "));
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
                // PR/review mail belongs to Reviews, not Noise.
                qb.push(format!(" AND NOT {GITHUB_PR_MATCH} "));
            }
            _ => {}
        }
    }
}

fn push_search(qb: &mut QueryBuilder<'_, sqlx::Postgres>, filters: &EmailListFilters) {
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
}

pub async fn list(pool: &PgPool, filters: EmailListFilters) -> sqlx::Result<Vec<EmailListRow>> {
    // Fetch page_size + 1 so the caller can compute `has_more` without a COUNT.
    let query_limit = (filters.page_size + 1) as i64;

    let mut qb = QueryBuilder::new("");
    if filters.group_threads && folder_groups_threads(filters.folder.as_deref()) {
        push_grouped_list(&mut qb, &filters, query_limit);
    } else {
        // One row per email: the tenant scope, then the filters, then the
        // keyset cursor and page.
        let order = list_order(filters.folder.as_deref());
        let (dir, past) = order.direction();
        let sort = &order.per_email;
        qb.push("SELECT ");
        qb.push(LIST_COLUMNS);
        qb.push(format!(", {sort} AS sort_at"));
        push_scope(&mut qb, filters.user_id);
        push_account_and_status(&mut qb, &filters);
        push_folder(&mut qb, &filters, true);
        push_search(&mut qb, &filters);
        if let Some((before_ms, before_id)) = filters.before {
            // The cursor comes back in milliseconds (a JS Date), so compare at
            // that precision: against the stored microseconds, paging forward
            // (Snoozed) would return the cursor's own row forever, and paging
            // back would skip rows later in the same millisecond.
            qb.push(format!(
                " AND (date_trunc('milliseconds', {sort}), e.id) {past} (to_timestamp("
            ));
            qb.push_bind(before_ms);
            qb.push("::double precision / 1000.0), ");
            qb.push_bind(before_id);
            qb.push(")");
        }
        qb.push(format!(" ORDER BY {sort} {dir}, e.id {dir} LIMIT "));
        qb.push_bind(query_limit);
    }

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

/// One row per conversation, the way Gmail lists mail.
///
/// 1. `matched`: the conversations with at least one email in this view, using
///    exactly the per-email filters. Signal and Noise instead judge each
///    conversation by its newest *incoming* email still in the inbox, so a
///    reply of yours can't pull a conversation into Signal and the two chips
///    stay disjoint.
/// 2. `conv`: every email of those conversations the caller can see (trash,
///    spam and drafts aside), so your own sent reply counts as the newest
///    message and the conversation sorts by it, as in Gmail.
/// 3. The newest email of each conversation is its row, with the count, the
///    unread count, any attachment, every message id (for bulk actions) and
///    the unread ones (so marking read touches only those).
fn push_grouped_list(
    qb: &mut QueryBuilder<'_, sqlx::Postgres>,
    filters: &EmailListFilters,
    query_limit: i64,
) {
    qb.push("WITH matched AS (");
    if matches!(filters.folder.as_deref(), Some("signal" | "noise")) {
        qb.push("SELECT e.conv_key FROM (SELECT DISTINCT ON (");
        qb.push(CONV_KEY);
        qb.push(") e.*, ");
        qb.push(CONV_KEY);
        qb.push(" AS conv_key");
        push_scope(qb, filters.user_id);
        push_account_and_status(qb, filters);
        push_search(qb, filters);
        qb.push(" AND NOT ('SENT' = ANY(e.labels)) AND ");
        qb.push(GMAIL_IN_INBOX);
        qb.push(" ORDER BY ");
        qb.push(CONV_KEY);
        qb.push(", e.created_at DESC, e.id DESC) e WHERE TRUE ");
        push_folder(qb, filters, false);
    } else {
        qb.push("SELECT DISTINCT ");
        qb.push(CONV_KEY);
        qb.push(" AS conv_key");
        push_scope(qb, filters.user_id);
        push_account_and_status(qb, filters);
        push_folder(qb, filters, false);
        push_search(qb, filters);
    }
    let order = list_order(filters.folder.as_deref());
    qb.push("), conv AS (SELECT ");
    qb.push(LIST_COLUMNS);
    qb.push(format!(", {} AS sort_at, ", order.per_message));
    qb.push(CONV_KEY);
    qb.push(" AS conv_key, e.thread_id, e.sender_hash");
    push_scope(qb, filters.user_id);
    qb.push(" AND ");
    qb.push(CONV_KEY);
    qb.push(
        r#" IN (SELECT conv_key FROM matched)
              AND NOT ('TRASH' = ANY(e.labels))
              AND NOT ('SPAM' = ANY(e.labels))
              AND NOT ('DRAFT' = ANY(e.labels))),
        latest AS (
            SELECT DISTINCT ON (conv_key) * FROM conv
            ORDER BY conv_key, created_at DESC, id DESC),
        agg AS (
            SELECT conv_key,
                   COUNT(*)::BIGINT AS message_count,
                   (COUNT(*) FILTER (WHERE is_read = FALSE))::BIGINT AS unread_count,
                   BOOL_OR(has_attachments) AS any_attachments,
                   ARRAY_AGG(id ORDER BY created_at DESC, id DESC) AS message_ids,
                   COALESCE(ARRAY_AGG(id ORDER BY created_at DESC, id DESC)
                            FILTER (WHERE is_read = FALSE), '{}') AS unread_ids,
                   COALESCE(ARRAY_AGG(id ORDER BY created_at DESC, id DESC)
                            FILTER (WHERE is_starred), '{}') AS starred_ids,
                   MAX(sort_at) AS sort_at
            FROM conv GROUP BY conv_key),
        -- Who wrote in each conversation, once each, in order of their first
        -- message (capped), and whether any of their messages is unread, for
        -- a Gmail-style "Ayana, me" row with the unread names in bold.
        -- Senders are told apart by address hash, so nothing is decrypted to
        -- group them.
        senders AS (
            SELECT conv_key,
                   (ARRAY_AGG(COALESCE(sender_iv, '') ORDER BY first_at, id))[1:50] AS p_iv,
                   (ARRAY_AGG(COALESCE(sender_encrypted, '') ORDER BY first_at, id))[1:50] AS p_enc,
                   (ARRAY_AGG(COALESCE(sender, '') ORDER BY first_at, id))[1:50] AS p_plain,
                   (ARRAY_AGG(unread ORDER BY first_at, id))[1:50] AS p_unread
            FROM (SELECT DISTINCT ON (conv_key, sender_key)
                         conv_key, id, sender, sender_iv, sender_encrypted, created_at AS first_at,
                         BOOL_OR(NOT COALESCE(is_read, TRUE))
                             OVER (PARTITION BY conv_key, sender_key) AS unread
                  FROM (SELECT *, COALESCE(sender_hash, lower(sender)) AS sender_key FROM conv) c
                  ORDER BY conv_key, sender_key, created_at, id) first
            GROUP BY conv_key)
        SELECT l.id, l.gmail_id, l.subject, l.subject_iv, l.subject_encrypted,
               l.sender, l.receiver, l.sender_iv, l.sender_encrypted,
               l.receiver_iv, l.receiver_encrypted, l.has_body,
               g.any_attachments AS has_attachments,
               l.account_id, l.is_read, l.created_at, l.is_shared, l.shared_label,
               l.inbox_status, l.inbox_assignee_id, l.thread_id,
               g.message_count, g.unread_count, g.message_ids, g.unread_ids,
               g.starred_ids, (cardinality(g.starred_ids) > 0) AS is_starred,
               l.snoozed_until, g.sort_at,
               p.p_iv, p.p_enc, p.p_plain, p.p_unread
        FROM latest l JOIN agg g USING (conv_key) JOIN senders p USING (conv_key)
        WHERE TRUE"#,
    );
    // A conversation's snooze is its newest message's (see `push_folder`).
    match folder_snooze(filters.folder.as_deref()) {
        Some(SnoozeView::Hide) => {
            qb.push(format!(
                " AND (l.snoozed_until IS NULL OR l.snoozed_until <= {NOW_UTC})"
            ));
        }
        Some(SnoozeView::Only) => {
            qb.push(format!(" AND l.snoozed_until > {NOW_UTC}"));
        }
        None => {}
    }
    let (dir, past) = order.direction();
    if let Some((before_ms, before_id)) = filters.before {
        // Millisecond precision, as the cursor has (see `list`).
        qb.push(format!(
            " AND (date_trunc('milliseconds', g.sort_at), l.id) {past} (to_timestamp("
        ));
        qb.push_bind(before_ms);
        qb.push("::double precision / 1000.0), ");
        qb.push_bind(before_id);
        qb.push(")");
    }
    qb.push(format!(" ORDER BY g.sort_at {dir}, l.id {dir} LIMIT "));
    qb.push_bind(query_limit);
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
        thread_id: row.try_get::<Option<i32>, _>("thread_id").ok().flatten(),
        message_count: row
            .try_get::<Option<i64>, _>("message_count")
            .ok()
            .flatten(),
        unread_count: row.try_get::<Option<i64>, _>("unread_count").ok().flatten(),
        message_ids: row
            .try_get::<Option<Vec<i32>>, _>("message_ids")
            .ok()
            .flatten(),
        unread_ids: row
            .try_get::<Option<Vec<i32>>, _>("unread_ids")
            .ok()
            .flatten(),
        is_starred: row.try_get::<bool, _>("is_starred").unwrap_or(false),
        snoozed_until: row
            .try_get::<Option<NaiveDateTime>, _>("snoozed_until")
            .ok()
            .flatten(),
        sort_at: row
            .try_get::<Option<NaiveDateTime>, _>("sort_at")
            .ok()
            .flatten(),
        starred_ids: row
            .try_get::<Option<Vec<i32>>, _>("starred_ids")
            .ok()
            .flatten(),
        participants: read_participants(&row),
    }
}

/// The grouped list's senders, decrypted the way `read_sender` decrypts one.
/// None outside the grouped list.
fn read_participants(row: &PgRow) -> Option<Vec<Participant>> {
    let ivs: Vec<String> = row.try_get("p_iv").ok()?;
    let encs: Vec<String> = row.try_get("p_enc").ok()?;
    let plains: Vec<String> = row.try_get("p_plain").ok()?;
    let unread: Vec<bool> = row.try_get("p_unread").ok()?;
    Some(
        ivs.iter()
            .zip(&encs)
            .zip(&plains)
            .zip(&unread)
            .filter_map(|(((iv, enc), plain), &unread)| {
                let sender = if iv.is_empty() || enc.is_empty() {
                    plain.clone()
                } else {
                    wayve_security::encryption::decrypt(iv, enc).unwrap_or_else(|_| plain.clone())
                };
                (!sender.is_empty()).then_some(Participant { sender, unread })
            })
            .collect(),
    )
}

/// Every message of `email_id`'s conversation that the caller can see, oldest
/// first, as list rows (bodies load per message through the detail endpoints).
/// The email itself is always included; the rest of its conversation is too,
/// trash, spam and drafts aside. An email the caller can't see returns nothing:
/// the thread lookup runs under the same tenant scope and row-level security,
/// so another user's id never reveals a conversation.
pub async fn thread_messages(
    pool: &PgPool,
    email_id: i32,
    user_id: i32,
) -> sqlx::Result<Vec<EmailListRow>> {
    let mut qb = QueryBuilder::new("SELECT ");
    qb.push(LIST_COLUMNS);
    push_scope(&mut qb, user_id);
    qb.push(" AND (e.id = ");
    qb.push_bind(email_id);
    qb.push(
        " OR (e.thread_id IS NOT NULL \
              AND e.thread_id = (SELECT t.thread_id FROM emails t WHERE t.id = ",
    );
    qb.push_bind(email_id);
    qb.push(
        ") \
              AND NOT ('TRASH' = ANY(e.labels)) AND NOT ('SPAM' = ANY(e.labels)) \
              AND NOT ('DRAFT' = ANY(e.labels)))) \
         ORDER BY e.created_at ASC, e.id ASC LIMIT 500",
    );

    let mut tx = pool.begin().await?;
    sqlx::raw_sql(&format!(
        "SELECT set_config('app.user_id', '{user_id}', true); SET LOCAL ROLE wayve_app;"
    ))
    .execute(&mut *tx)
    .await?;
    let raw = qb.build().fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(raw.into_iter().map(map_list_row).collect())
}

/// Single-row read for the `/emails/{id}` detail endpoint. The body stays as
/// the raw envelope (iv + ciphertext) so the caller can decrypt and cache it.
pub struct EmailDetailRow {
    pub id: i32,
    pub account_id: Option<i32>,
    pub subject: Option<String>,
    pub sender: Option<String>,
    pub receiver: Option<String>,
    /// `None` while unknown, `Some("")` when the message had no Cc.
    pub cc: Option<String>,
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
               e.cc_iv, e.cc_encrypted,
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
        cc: read_cc(&r),
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
    /// The Cc header. `None` when the provider response didn't say, which keeps
    /// whatever is stored; `Some("")` records that the message had no Cc.
    pub cc: Option<&'a str>,
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
    let placeholders_per_row = 20;
    let mut query = String::from(
        "INSERT INTO emails(gmail_id, sender, receiver, subject_iv, subject_encrypted, \
         created_at, body_encrypted, body_iv, account_id, is_read, labels, \
         attachments_checked, sender_iv, sender_encrypted, sender_hash, \
         receiver_iv, receiver_encrypted, receiver_hash, cc_iv, cc_encrypted) VALUES ",
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
    // so a plain assignment would flip just-opened mail back to unread. Mail
    // re-marked unread in Gmail is caught up by email/label_history.rs instead.
    // An unknown (NULL) Cc keeps the stored one.
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
         cc_iv = COALESCE(EXCLUDED.cc_iv, emails.cc_iv), \
         cc_encrypted = COALESCE(EXCLUDED.cc_encrypted, emails.cc_encrypted), \
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
    let mut cc_envelopes: Vec<(Option<String>, Option<String>)> = Vec::with_capacity(batch.len());
    for row in batch {
        subject_envelopes.push(encrypt_subject_for_storage(row.subject));
        sender_envelopes.push(encrypt_address_for_storage(row.sender));
        receiver_envelopes.push(encrypt_address_for_storage(row.receiver));
        cc_envelopes.push(encrypt_cc_for_storage(row.cc));
    }
    for (
        ((row, (subject_iv, subject_encrypted)), ((s_iv, s_ct, s_hash), (r_iv, r_ct, r_hash))),
        (cc_iv, cc_ct),
    ) in batch
        .iter()
        .zip(subject_envelopes.iter())
        .zip(sender_envelopes.iter().zip(receiver_envelopes.iter()))
        .zip(cc_envelopes.iter())
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
            .bind(r_hash.as_str())
            .bind(cc_iv.as_deref())
            .bind(cc_ct.as_deref());
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

    // Feed the contacts projection from genuinely-new rows only — sync re-fetches
    // the last hour every tick, so recording every returned row would inflate the
    // per-contact message count. Best-effort; never fails the upsert.
    let new_ids: std::collections::HashSet<&str> = results
        .iter()
        .filter(|r| r.is_new)
        .map(|r| r.gmail_id.as_str())
        .collect();
    if !new_ids.is_empty() {
        let mut addrs: Vec<&str> = Vec::with_capacity(new_ids.len() * 2);
        for row in batch {
            if new_ids.contains(row.gmail_id) {
                addrs.push(row.sender);
                addrs.push(row.receiver);
            }
        }
        crate::email::contacts::record_from_addresses(pool, account_id, addrs).await;
    }

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

/// Snoozes an email until `until` (UTC), or with `None` ends a snooze that has
/// not run out yet, so the email goes back to its own place in the list (an
/// Undo). A snooze that already ran out is left alone: it is what keeps
/// returned mail at the top. Returns whether anything changed.
pub async fn set_snoozed(
    pool: &PgPool,
    email_id: i32,
    until: Option<NaiveDateTime>,
) -> sqlx::Result<bool> {
    let changed = match until {
        Some(until) => sqlx::query("UPDATE emails SET snoozed_until = $2 WHERE id = $1")
            .bind(email_id)
            .bind(until)
            .execute(pool)
            .await?
            .rows_affected(),
        None => sqlx::query(&format!(
            "UPDATE emails SET snoozed_until = NULL \
             WHERE id = $1 AND snoozed_until > {NOW_UTC}"
        ))
        .bind(email_id)
        .execute(pool)
        .await?
        .rows_affected(),
    };
    Ok(changed > 0)
}

/// Stars or unstars an email: the STARRED label, as Gmail stores it.
pub async fn set_starred(pool: &PgPool, email_id: i32, starred: bool) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE emails SET labels = CASE \
           WHEN $2 THEN array_append(array_remove(labels, 'STARRED'), 'STARRED') \
           ELSE array_remove(labels, 'STARRED') \
         END \
         WHERE id = $1",
    )
    .bind(email_id)
    .bind(starred)
    .execute(pool)
    .await?;
    Ok(())
}

/// Labels an email as deleted (TRASH) or takes the label off again, keeping its
/// other labels so a restore puts it back where it was. A restore also ends a
/// snooze still pending, so restored mail is in the inbox, not hidden from it. `moved` is what the
/// provider reported: a new provider id is stored (a moved Outlook message gets
/// one), and a restore the provider says landed in the inbox gets INBOX back
/// (Gmail drops it from trashed mail, and sync may have mirrored that).
pub async fn set_trashed(
    pool: &PgPool,
    email_id: i32,
    trashed: bool,
    moved: &crate::email::provider::TrashMoved,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE emails SET \
           labels = CASE \
             WHEN $2 THEN array_append(array_remove(labels, 'TRASH'), 'TRASH') \
             WHEN $3 THEN array_append(array_remove(array_remove(labels, 'TRASH'), 'INBOX'), 'INBOX') \
             ELSE array_remove(labels, 'TRASH') \
           END, \
           gmail_id = COALESCE($4, gmail_id), \
           snoozed_until = CASE \
             WHEN NOT $2 AND snoozed_until > (now() AT TIME ZONE 'UTC') THEN NULL \
             ELSE snoozed_until \
           END \
         WHERE id = $1",
    )
    .bind(email_id)
    .bind(trashed)
    .bind(moved.in_inbox)
    .bind(moved.new_id.as_deref())
    .execute(pool)
    .await?;
    Ok(())
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
    let (cc_iv, cc_encrypted) = encrypt_cc_for_storage(row.cc);
    // `(xmax = 0) AS is_new` distinguishes a genuinely new row from an
    // ON CONFLICT re-sync, so only the former stamps last_message_at.
    let returned = sqlx::query(
        r#"
        INSERT INTO emails
          (gmail_id, sender, receiver, subject_iv, subject_encrypted, created_at,
           body_encrypted, body_iv, account_id, attachments_checked, is_read, labels,
           sender_iv, sender_encrypted, sender_hash,
           receiver_iv, receiver_encrypted, receiver_hash, cc_iv, cc_encrypted)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17, $18, $19, $20)
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
          cc_iv = COALESCE(EXCLUDED.cc_iv, emails.cc_iv),
          cc_encrypted = COALESCE(EXCLUDED.cc_encrypted, emails.cc_encrypted),
          created_at = EXCLUDED.created_at,
          body_encrypted = EXCLUDED.body_encrypted,
          body_iv = EXCLUDED.body_iv,
          is_read = emails.is_read OR EXCLUDED.is_read,
          -- IMAP mail is trashed and starred in Fluxze only (the server copy
          -- stays in INBOX, unflagged), so its sync must not clear the TRASH
          -- or STARRED label. Outlook's labels come from the provider, which
          -- knows what is in Deleted Items and what is flagged.
          labels = CASE
            WHEN emails.labels && ARRAY['TRASH', 'STARRED']
             AND (SELECT provider FROM email_accounts WHERE id = emails.account_id) = 'imap'
            THEN ARRAY(
              SELECT l FROM unnest(EXCLUDED.labels) AS l
               WHERE l NOT IN ('TRASH', 'STARRED')
              UNION ALL
              SELECT l FROM unnest(emails.labels) AS l
               WHERE l IN ('TRASH', 'STARRED'))
            ELSE EXCLUDED.labels
          END
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
    .bind(&cc_iv)
    .bind(&cc_encrypted)
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

/// One-time backfill of the `email_contacts` projection from existing mail.
///
/// Gated on an empty table: it runs on the first startup after the projection
/// ships, then never again — thereafter the sync path keeps contacts current
/// (including the historical sync of newly-connected accounts). Because it only
/// runs against an empty table, `increment = true` yields accurate per-contact
/// counts without any cross-run inflation risk. Returns the number of email rows
/// scanned (0 when skipped).
pub async fn backfill_contacts(pool: &PgPool) -> sqlx::Result<u64> {
    let already: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM email_contacts)")
        .fetch_one(pool)
        .await?;
    if already {
        return Ok(0);
    }

    const BATCH: i64 = 500;
    let mut total: u64 = 0;
    let mut last_id: i32 = 0;
    loop {
        let rows = sqlx::query(
            "SELECT e.id, e.sender, e.receiver, e.sender_iv, e.sender_encrypted, \
                    e.receiver_iv, e.receiver_encrypted, \
                    ea.user_id AS acct_user_id, ea.email AS own_email \
             FROM emails e \
             JOIN email_accounts ea ON ea.id = e.account_id \
             WHERE e.id > $1 \
             ORDER BY e.id \
             LIMIT $2",
        )
        .bind(last_id)
        .bind(BATCH)
        .fetch_all(pool)
        .await?;
        if rows.is_empty() {
            return Ok(total);
        }
        let count = rows.len() as u64;

        // Aggregate this page by (user_id, address) so a contact that appears on
        // several rows is one upsert with the right count.
        let mut agg: std::collections::HashMap<(i32, String), (String, i32)> =
            std::collections::HashMap::new();
        for row in &rows {
            last_id = row.try_get("id").unwrap_or(last_id);
            let user_id: i32 = match row.try_get("acct_user_id") {
                Ok(v) => v,
                Err(_) => continue,
            };
            let own_email: String = row.try_get("own_email").unwrap_or_default();
            let own = own_email.trim().to_lowercase();
            for raw in [read_sender(row), read_receiver(row)].into_iter().flatten() {
                // A single sender/receiver field can be a multi-recipient list;
                // parse_contacts splits it so each address gets its own name.
                for (addr, name) in crate::email::contacts::parse_contacts(&raw) {
                    if addr == own {
                        continue;
                    }
                    let entry = agg.entry((user_id, addr)).or_insert((String::new(), 0));
                    entry.1 += 1;
                    if entry.0.is_empty() && !name.is_empty() {
                        entry.0 = name;
                    }
                }
            }
        }
        for ((user_id, address), (display_name, c)) in agg {
            crate::email::contacts::upsert(pool, user_id, &address, &display_name, c, true).await;
        }

        total += count;
        if (count as i64) < BATCH {
            return Ok(total);
        }
    }
}
