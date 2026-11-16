//! Which of an account's history backfills have finished, and the one place
//! that skips, runs and marks them.
//!
//! Every sync tick runs a set of backfills per account (older mail, each label,
//! GitHub mail, threading, Cc). Each one first scans the account's mail to find
//! where it left off, then asks the provider for the next page. Once the
//! history is exhausted both steps find nothing, but without a record of that
//! they would repeat every 30 seconds forever.
//!
//! `email_accounts.backfill_done` records `{kind: finished-at}`. [`run`] skips a
//! backfill that finished within [`RECHECK_HOURS`]; after that it runs once
//! more, which catches anything that appeared since (a message relabelled into
//! an older label page) and re-marks it if still empty. A backfill function only
//! reports what its batch found ([`Batch`]); it never touches this state itself.

use crate::prelude::*;
use std::collections::HashSet;
use std::future::Future;
use tracing::warn;

/// How long a finished backfill is skipped before it is checked again.
const RECHECK_HOURS: i32 = 24;

/// One history backfill. The stored key is derived here only, so the check in
/// [`run`] and the mark it writes can never disagree.
#[derive(Clone, Copy, Debug)]
pub enum Backfill<'a> {
    /// All mail older than the oldest local message.
    Older,
    /// Emails not yet placed in a conversation.
    Threading,
    /// Gmail mail synced before Cc was stored.
    Cc,
    /// Mail carrying one provider label, older than the oldest local one.
    Label(&'a str),
    /// Mail matching one provider search query.
    Query(&'a str),
}

impl Backfill<'_> {
    fn key(self) -> String {
        match self {
            Self::Older => "older".to_string(),
            Self::Threading => "threading".to_string(),
            Self::Cc => "cc".to_string(),
            Self::Label(label) => format!("label:{label}"),
            Self::Query(query) => format!("query:{query}"),
        }
    }
}

/// What one batch of a backfill found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Batch {
    /// There may be more to do (or it could not tell yet): run again next tick.
    More,
    /// Nothing is left: mark the backfill finished.
    Exhausted,
}

impl Batch {
    /// For a backfill that works off a pending list: an empty one is exhausted.
    pub fn from_pending(pending: usize) -> Self {
        if pending == 0 {
            Self::Exhausted
        } else {
            Self::More
        }
    }
}

/// The backfills of one account that finished recently enough to skip.
#[derive(Debug, Default)]
pub struct Finished(HashSet<String>);

impl Finished {
    pub fn contains(&self, backfill: Backfill<'_>) -> bool {
        self.0.contains(&backfill.key())
    }
}

/// The account's finished backfills. Empty on error, so a failed lookup only
/// costs one ordinary tick.
pub async fn finished(pool: &PgPool, account_id: i32) -> Finished {
    let keys: sqlx::Result<Vec<String>> = sqlx::query_scalar(
        "SELECT d.key FROM email_accounts ea, jsonb_each_text(ea.backfill_done) d \
         WHERE ea.id = $1 \
           AND d.value::timestamptz > NOW() - make_interval(hours => $2)",
    )
    .bind(account_id)
    .bind(RECHECK_HOURS)
    .fetch_all(pool)
    .await;
    match keys {
        Ok(keys) => Finished(keys.into_iter().collect()),
        Err(e) => {
            warn!(target: "worker", account_id, error = ?e, "backfill state lookup failed");
            Finished::default()
        }
    }
}

/// Run one batch of `backfill` unless it is in `done`, and mark it finished when
/// the batch reports [`Batch::Exhausted`]. Errors are logged and leave the state
/// alone, so the backfill simply runs again next tick. `batch` is lazy: nothing
/// in it runs for a skipped backfill.
pub async fn run<F>(
    pool: &PgPool,
    account_id: i32,
    done: &Finished,
    backfill: Backfill<'_>,
    batch: F,
) where
    F: Future<Output = anyhow::Result<Batch>>,
{
    if done.contains(backfill) {
        return;
    }
    match batch.await {
        Ok(Batch::More) => {}
        Ok(Batch::Exhausted) => mark_finished(pool, account_id, backfill).await,
        Err(e) => {
            warn!(target: "worker", account_id, backfill = %backfill.key(), error = ?e, "history backfill failed");
        }
    }
}

/// Record that `backfill` found nothing left to do.
pub async fn mark_finished(pool: &PgPool, account_id: i32, backfill: Backfill<'_>) {
    let key = backfill.key();
    let res = sqlx::query(
        "UPDATE email_accounts \
         SET backfill_done = backfill_done || jsonb_build_object($2::text, NOW()) \
         WHERE id = $1",
    )
    .bind(account_id)
    .bind(&key)
    .execute(pool)
    .await;
    if let Err(e) = res {
        warn!(target: "worker", account_id, backfill = %key, error = ?e, "marking backfill finished failed");
    }
}

/// Forget that `backfill` finished, so the next tick runs it again.
pub async fn reopen(pool: &PgPool, account_id: i32, backfill: Backfill<'_>) {
    let key = backfill.key();
    let res = sqlx::query(
        "UPDATE email_accounts SET backfill_done = backfill_done - $2::text \
         WHERE id = $1 AND backfill_done ? $2::text",
    )
    .bind(account_id)
    .bind(&key)
    .execute(pool)
    .await;
    if let Err(e) = res {
        warn!(target: "worker", account_id, backfill = %key, error = ?e, "reopening backfill failed");
    }
}
