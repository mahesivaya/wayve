//! Completes a Gmail conversation the first time it is opened.
//!
//! Scrolling the Inbox fetches only INBOX mail and the sync only recent mail, so
//! an older conversation can be missing your replies and its archived messages.
//! Opening it asks Gmail for the whole thread and stores what is missing, once:
//! `email_threads.completed_at` records that it was done. Later messages arrive
//! through the normal sync.

use crate::email::account::load_user_email_accounts_for_older_sync;
use crate::email::provider::{MailProvider, refresh_and_persist_email_token};
use crate::email::sync::{fetch_gmail_thread_message_ids, sync_ids};
use sqlx::PgPool;

/// Most messages one completion stores, to bound the provider round-trips.
const MAX_MISSING: usize = 100;

/// Fetches the messages of `email_id`'s conversation that aren't stored yet.
/// Only for the mailbox's owner, Gmail, and a conversation not completed
/// before. True when it stored anything, so the caller reloads the list.
pub async fn complete_conversation(
    pool: &PgPool,
    user_id: i32,
    email_id: i32,
) -> anyhow::Result<bool> {
    let row: Option<(i32, i32, String)> = sqlx::query_as(
        "SELECT e.thread_id, e.account_id, e.gmail_id FROM emails e \
         JOIN email_accounts a ON a.id = e.account_id \
         JOIN email_threads t ON t.id = e.thread_id \
         WHERE e.id = $1 AND a.user_id = $2 AND a.provider = 'google' \
           AND e.source <> 'wayve' AND t.completed_at IS NULL",
    )
    .bind(email_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    let Some((thread_id, account_id, gmail_id)) = row else {
        return Ok(false);
    };

    let accounts = load_user_email_accounts_for_older_sync(pool, user_id, Some(account_id)).await?;
    let Some(account) = accounts
        .into_iter()
        .find(|a| a.provider == MailProvider::Google)
    else {
        return Ok(false);
    };
    let Some(refresh_token) = account.usable_refresh_token() else {
        return Ok(false);
    };
    let token = refresh_and_persist_email_token(pool, account.id, account.provider, refresh_token)
        .await?
        .access_token;

    store_missing(pool, account_id, thread_id, &gmail_id, &token).await
}

/// The provider half of `complete_conversation`, given a token: stores the
/// messages of `gmail_id`'s Gmail thread that the mailbox lacks and marks the
/// conversation completed.
pub(crate) async fn store_missing(
    pool: &PgPool,
    account_id: i32,
    thread_id: i32,
    gmail_id: &str,
    token: &str,
) -> anyhow::Result<bool> {
    let ids = fetch_gmail_thread_message_ids(token, gmail_id).await?;
    let stored: Vec<String> = sqlx::query_scalar(
        "SELECT gmail_id FROM emails WHERE account_id = $1 AND gmail_id = ANY($2)",
    )
    .bind(account_id)
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    let missing: Vec<String> = ids
        .into_iter()
        .filter(|id| !stored.contains(id))
        .take(MAX_MISSING)
        .collect();
    let fetched = !missing.is_empty();
    if fetched {
        sync_ids(pool, account_id, token, missing).await?;
    }

    sqlx::query("UPDATE email_threads SET completed_at = NOW() WHERE id = $1")
        .bind(thread_id)
        .execute(pool)
        .await?;
    Ok(fetched)
}
