//! Which of an account's history backfills have finished.
//!
//! Every sync tick runs a set of backfills per account (older mail, each label,
//! GitHub mail, threading, Cc). Each one first scans the account's mail to find
//! where it left off, then asks the provider for the next page. Once the
//! history is exhausted both steps find nothing, but without a record of that
//! they would repeat every 30 seconds forever.
//!
//! `email_accounts.backfill_done` records `{kind: finished-at}`. A kind that
//! finished within [`RECHECK`] is skipped outright; after that it runs once more,
//! which catches anything that appeared since (a row whose threading failed, a
//! message relabelled into an older label page) and re-marks it if still empty.

use crate::prelude::*;
use std::collections::HashSet;
use tracing::warn;

/// How long a finished backfill is skipped before it is checked again.
const RECHECK_HOURS: i32 = 24;

pub const OLDER: &str = "older";
pub const THREADING: &str = "threading";
pub const CC: &str = "cc";

/// The kind for one label's backfill.
pub fn label(label: &str) -> String {
    format!("label:{label}")
}

/// The kind for one search-query backfill.
pub fn query(query: &str) -> String {
    format!("query:{query}")
}

/// The kinds of this account that finished recently enough to skip. Empty on
/// error, so a failed lookup only costs one ordinary tick.
pub async fn finished(pool: &PgPool, account_id: i32) -> HashSet<String> {
    let kinds: sqlx::Result<Vec<String>> = sqlx::query_scalar(
        "SELECT d.key FROM email_accounts ea, jsonb_each_text(ea.backfill_done) d \
         WHERE ea.id = $1 \
           AND d.value::timestamptz > NOW() - make_interval(hours => $2)",
    )
    .bind(account_id)
    .bind(RECHECK_HOURS)
    .fetch_all(pool)
    .await;
    match kinds {
        Ok(kinds) => kinds.into_iter().collect(),
        Err(e) => {
            warn!(target: "worker", account_id, error = ?e, "backfill state lookup failed");
            HashSet::new()
        }
    }
}

/// Record that `kind` found nothing left to backfill.
pub async fn mark_finished(pool: &PgPool, account_id: i32, kind: &str) {
    let res = sqlx::query(
        "UPDATE email_accounts \
         SET backfill_done = backfill_done || jsonb_build_object($2::text, NOW()) \
         WHERE id = $1",
    )
    .bind(account_id)
    .bind(kind)
    .execute(pool)
    .await;
    if let Err(e) = res {
        warn!(target: "worker", account_id, kind, error = ?e, "marking backfill finished failed");
    }
}

/// Forget that `kind` finished, so the next tick runs it again.
pub async fn reopen(pool: &PgPool, account_id: i32, kind: &str) {
    let res = sqlx::query(
        "UPDATE email_accounts SET backfill_done = backfill_done - $2::text \
         WHERE id = $1 AND backfill_done ? $2::text",
    )
    .bind(account_id)
    .bind(kind)
    .execute(pool)
    .await;
    if let Err(e) = res {
        warn!(target: "worker", account_id, kind, error = ?e, "reopening backfill failed");
    }
}
