//! Database transaction helpers.
//!
//! `with_tx` wraps `pool.begin()` / `tx.commit()` in a closure-based call. The
//! closure takes ownership of the `Transaction` and returns `(tx, value)` on
//! success so the wrapper can commit; on any `?` failure the `Transaction` drops
//! and sqlx rolls it back. Existing handlers are not migrated; use this in new code.
//!
//! ```ignore
//! let id = db::with_tx(&pool, |mut tx| async move {
//!     let id: i32 = sqlx::query_scalar("INSERT … RETURNING id")
//!         .fetch_one(&mut *tx)
//!         .await?;
//!     Ok((tx, id))
//! }).await?;
//! ```

use crate::error::AppError;
use sqlx::{PgPool, Postgres, Transaction};
use std::future::Future;

#[allow(dead_code)]
pub async fn with_tx<R, F, Fut>(pool: &PgPool, f: F) -> Result<R, AppError>
where
    F: FnOnce(Transaction<'static, Postgres>) -> Fut,
    Fut: Future<Output = Result<(Transaction<'static, Postgres>, R), AppError>>,
{
    let tx = pool.begin().await?;
    let (tx, value) = f(tx).await?;
    tx.commit().await?;
    Ok(value)
}

// Row-Level Security session context.
//
// RLS policies filter on Postgres GUCs naming the caller: `app.user_id` is the
// row owner, `app.bypass = 'on'` marks privileged, already-authorized
// cross-tenant work (platform aggregates, member recovery, org teardown,
// workers). Both are transaction-local, so they auto-reset on COMMIT/ROLLBACK
// and a pooled connection can never leak one request's context into the next.
//
// The connecting role (wayve_user / rwayve) is a SUPERUSER and bypasses RLS
// unconditionally. A user-scoped transaction therefore sets the GUC and then
// `SET LOCAL ROLE wayve_app`, a restricted non-superuser role, or the policy
// never engages. Privileged paths stay superuser and read/write everything.
//
// Policies are deny-by-default, so every access path to an RLS-enabled table must
// run inside one of the helpers below; a missed path is a visible 0-rows bug, not
// a cross-tenant leak.

/// Scope an existing transaction to one user: set `app.user_id` then drop to the
/// restricted `wayve_app` role (see infra/postgres/init.sql) so the RLS policy
/// applies. Both are transaction-local.
pub async fn apply_rls_user(
    tx: &mut Transaction<'_, Postgres>,
    user_id: i32,
) -> Result<(), AppError> {
    // One simple-query round-trip for both statements: this is the hottest
    // authenticated path, and `set_config` (needs a bind) can't be combined with
    // `SET LOCAL ROLE` (can't be parameterized) under the extended protocol.
    // Inlining `user_id` is safe because an `i32` is decimal digits only.
    let sql =
        format!("SELECT set_config('app.user_id', '{user_id}', true); SET LOCAL ROLE wayve_app;");
    sqlx::raw_sql(&sql).execute(&mut **tx).await?;
    Ok(())
}

/// Set `app.bypass = 'on'` on an existing transaction. Only for privileged paths
/// that have already done their own RBAC authorization.
pub async fn apply_rls_bypass(tx: &mut Transaction<'_, Postgres>) -> Result<(), AppError> {
    sqlx::query("SELECT set_config('app.bypass', 'on', true)")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Begin a transaction scoped to one user, run the closure, and commit. For
/// user-private tables where a handler only touches the caller's own rows.
pub async fn with_rls_user_tx<R, F, Fut>(pool: &PgPool, user_id: i32, f: F) -> Result<R, AppError>
where
    F: FnOnce(Transaction<'static, Postgres>) -> Fut,
    Fut: Future<Output = Result<(Transaction<'static, Postgres>, R), AppError>>,
{
    let mut tx = pool.begin().await?;
    apply_rls_user(&mut tx, user_id).await?;
    let (tx, value) = f(tx).await?;
    tx.commit().await?;
    Ok(value)
}

/// Begin a privileged cross-tenant transaction, run the closure, and commit. Only
/// for paths that have done their own authorization. Most call sites use the
/// inline `apply_rls_bypass` instead; this is kept for symmetry.
#[allow(dead_code)]
pub async fn with_rls_bypass_tx<R, F, Fut>(pool: &PgPool, f: F) -> Result<R, AppError>
where
    F: FnOnce(Transaction<'static, Postgres>) -> Fut,
    Fut: Future<Output = Result<(Transaction<'static, Postgres>, R), AppError>>,
{
    let mut tx = pool.begin().await?;
    apply_rls_bypass(&mut tx).await?;
    let (tx, value) = f(tx).await?;
    tx.commit().await?;
    Ok(value)
}
