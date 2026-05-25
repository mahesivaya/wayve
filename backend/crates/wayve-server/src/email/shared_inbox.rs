//! Helpers for shared inboxes (org and platform-level).
//!
//! A "shared inbox" is an `email_accounts` row with `is_shared = TRUE`. The
//! owner-user keeps full access; additional users listed in
//! `shared_inbox_members` can read and (if `can_reply`) send from the
//! account. Workflow state (open / pending / closed + assignee) lives in
//! `shared_inbox_email_state`, one row per email, created lazily on first
//! mutation.
//!
//! All access-control logic for shared inboxes funnels through this file
//! so the rules are stated in one place. Routes and the email send path
//! call into here rather than rolling their own SQL.

use crate::prelude::*;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One workflow row as exposed to the UI. Matches a JOIN against
/// `shared_inbox_email_state` LEFT-JOINed onto an emails query.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct InboxState {
    pub email_id: i32,
    pub status: String,
    pub assignee_id: Option<i32>,
    pub updated_at: Option<DateTime<Utc>>,
    pub updated_by: Option<i32>,
}

/// Membership row joined with the user's email so the admin page can list
/// "who has access" without an additional /api/users lookup.
#[derive(Debug, Serialize, FromRow)]
pub struct InboxMember {
    pub account_id: i32,
    pub user_id: i32,
    pub email: String,
    pub first_name: Option<String>,
    pub can_reply: bool,
    pub can_manage: bool,
    pub created_at: DateTime<Utc>,
}

/// Partial-update payload. `serde` doesn't distinguish "absent key" from
/// "explicit null" for `Option<T>`, so we encode the "unassign" intent
/// with a separate `clear_assignee` flag rather than relying on
/// `Option<Option<i32>>` magic.
#[derive(Debug, Deserialize)]
pub struct StatusUpdate {
    pub status: Option<String>,   // "open" | "pending" | "closed"
    pub assignee_id: Option<i32>, // Some = assign; absent = leave alone
    #[serde(default)]
    pub clear_assignee: bool, // true = explicit unassign (overrides assignee_id)
}

/// Validate a status string against the CHECK constraint in init.sql.
pub fn is_valid_status(s: &str) -> bool {
    matches!(s, "open" | "pending" | "closed")
}

/// Does `user_id` have *any* access to `account_id` — either as the
/// owner-user OR as a shared-inbox member? This is the gate every
/// read-path handler should call before showing data.
pub async fn can_access_account(
    pool: &PgPool,
    user_id: i32,
    account_id: i32,
) -> sqlx::Result<bool> {
    let row: Option<(i32,)> = sqlx::query_as(
        r#"
        SELECT 1
          FROM email_accounts a
          LEFT JOIN shared_inbox_members m
            ON m.account_id = a.id AND m.user_id = $1
         WHERE a.id = $2
           AND (a.user_id = $1 OR m.user_id IS NOT NULL)
         LIMIT 1
        "#,
    )
    .bind(user_id)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Does `user_id` have `can_reply` rights on `account_id`? Owner always
/// gets reply rights; shared members only if their row says so. Currently
/// unused in handlers because `load_email_account_for_send` enforces the
/// same gate at the SQL level — kept around as the canonical predicate
/// in case a future handler wants a check decoupled from a row load.
#[allow(dead_code)]
pub async fn can_reply_from_account(
    pool: &PgPool,
    user_id: i32,
    account_id: i32,
) -> sqlx::Result<bool> {
    let row: Option<(bool,)> = sqlx::query_as(
        r#"
        SELECT (a.user_id = $1 OR (m.user_id IS NOT NULL AND m.can_reply))::bool AS allowed
          FROM email_accounts a
          LEFT JOIN shared_inbox_members m
            ON m.account_id = a.id AND m.user_id = $1
         WHERE a.id = $2
         LIMIT 1
        "#,
    )
    .bind(user_id)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(allowed,)| allowed).unwrap_or(false))
}

/// Lazily create-or-update a workflow row. `status` and `assignee_id`
/// follow the `StatusUpdate` partial-update semantics (None = leave
/// alone; Some(None) on assignee = unassign).
pub async fn upsert_state(
    pool: &PgPool,
    email_id: i32,
    actor_id: i32,
    update: &StatusUpdate,
) -> Result<InboxState, String> {
    if let Some(s) = &update.status
        && !is_valid_status(s)
    {
        return Err(format!("Invalid status: {s}"));
    }

    // Build the UPDATE columns dynamically so we don't overwrite fields
    // the caller didn't mention. `COALESCE` would have the same effect
    // for `status`, but `assignee_id = NULL` has to be distinguishable
    // from "leave alone".
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    // Decide initial assignee for the INSERT branch.
    let initial_assignee = if update.clear_assignee {
        None
    } else {
        update.assignee_id
    };

    // Insert a row if none exists. ON CONFLICT DO NOTHING then partial
    // UPDATE — straightforward upsert + selective patch.
    sqlx::query(
        r#"
        INSERT INTO shared_inbox_email_state (email_id, status, assignee_id, updated_by, updated_at)
        VALUES ($1, COALESCE($2, 'open'), $3, $4, NOW())
        ON CONFLICT (email_id) DO NOTHING
        "#,
    )
    .bind(email_id)
    .bind(update.status.as_deref())
    .bind(initial_assignee)
    .bind(actor_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    if let Some(s) = &update.status {
        sqlx::query(
            "UPDATE shared_inbox_email_state SET status = $1, updated_at = NOW(), updated_by = $2 WHERE email_id = $3",
        )
        .bind(s)
        .bind(actor_id)
        .bind(email_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    if update.clear_assignee {
        sqlx::query(
            "UPDATE shared_inbox_email_state SET assignee_id = NULL, updated_at = NOW(), updated_by = $1 WHERE email_id = $2",
        )
        .bind(actor_id)
        .bind(email_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    } else if let Some(assignee) = update.assignee_id {
        sqlx::query(
            "UPDATE shared_inbox_email_state SET assignee_id = $1, updated_at = NOW(), updated_by = $2 WHERE email_id = $3",
        )
        .bind(assignee)
        .bind(actor_id)
        .bind(email_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    let row: InboxState = sqlx::query_as(
        "SELECT email_id, status, assignee_id, updated_at, updated_by
           FROM shared_inbox_email_state WHERE email_id = $1",
    )
    .bind(email_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(row)
}
