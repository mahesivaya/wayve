//! Shared inboxes, at org and platform level.
//!
//! A shared inbox is an `email_accounts` row with `is_shared = TRUE`. The owner
//! keeps full access; users in `shared_inbox_members` can read and, with
//! `can_reply`, send from it. Workflow state lives in
//! `shared_inbox_email_state`, one row per email, created lazily.
//!
//! All shared-inbox access control funnels through this file, so the rules are
//! stated once. Routes and the send path call in here rather than writing SQL.

use crate::prelude::*;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One workflow row as exposed to the UI.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct InboxState {
    pub email_id: i32,
    pub status: String,
    pub assignee_id: Option<i32>,
    pub updated_at: Option<DateTime<Utc>>,
    pub updated_by: Option<i32>,
}

/// Membership joined with the user's email, so the admin page can list who has
/// access without a second /api/users lookup.
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

/// Partial-update payload. `serde` can't distinguish an absent key from an
/// explicit null for `Option<T>`, so unassigning needs its own
/// `clear_assignee` flag.
#[derive(Debug, Deserialize)]
pub struct StatusUpdate {
    pub status: Option<String>,   // "open" | "pending" | "closed"
    pub assignee_id: Option<i32>, // Some = assign; absent = leave alone
    #[serde(default)]
    pub clear_assignee: bool, // true = explicit unassign (overrides assignee_id)
}

/// Must stay in sync with the CHECK constraint on
/// `shared_inbox_email_state.status` in init.sql.
pub fn is_valid_status(s: &str) -> bool {
    matches!(s, "open" | "pending" | "closed")
}

/// True when `user_id` is the owner of `account_id` or a shared-inbox member.
/// Every read-path handler must call this before showing data.
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

/// True when `user_id` may send from `account_id`: always for the owner, and for
/// a shared member whose row grants `can_reply`. Unused today because
/// `load_email_account_for_send` enforces the same gate in SQL; kept as the
/// canonical predicate for a handler that needs the check without a row load.
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

/// Creates or patches a workflow row, following `StatusUpdate`'s partial-update
/// semantics.
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

    // The UPDATE columns are built dynamically so fields the caller didn't
    // mention aren't overwritten. COALESCE would do for `status`, but
    // `assignee_id = NULL` must stay distinguishable from "leave alone".
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    let initial_assignee = if update.clear_assignee {
        None
    } else {
        update.assignee_id
    };

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
