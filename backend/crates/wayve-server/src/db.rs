//! Database transaction helpers.
//!
//! `with_tx` is a thin wrapper around `pool.begin()` / `tx.commit()` that
//! turns the common
//!
//! ```ignore
//! let mut tx = pool.begin().await?;
//! // … do work …
//! tx.commit().await?;
//! Ok(value)
//! ```
//!
//! into a single closure-based call. sqlx already rolls a transaction back
//! when it's dropped without committing, so the lifecycle is safe either way
//! — but `with_tx` makes "every path commits or returns the error" obvious to
//! a reader and impossible to forget.
//!
//! The closure takes ownership of the `Transaction` and must return
//! `(tx, value)` on success so the wrapper can commit. On any `?` failure
//! inside the closure, the `Transaction` drops and rolls back automatically.
//!
//! ```ignore
//! let id = db::with_tx(&pool, |mut tx| async move {
//!     let id: i32 = sqlx::query_scalar("INSERT … RETURNING id")
//!         .fetch_one(&mut *tx)
//!         .await?;
//!     sqlx::query("INSERT INTO audit …")
//!         .execute(&mut *tx)
//!         .await?;
//!     Ok((tx, id))
//! }).await?;
//! ```
//!
//! Existing transactional handlers are not migrated; adopt this in new code.

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

// ============================================================================
// Row-Level Security (RLS) session context.
//
// RLS policies filter on Postgres session GUCs naming the caller, set
// TRANSACTION-LOCAL (`set_config(..., is_local => true)`) so they auto-reset on
// COMMIT/ROLLBACK — a pooled connection can never leak one request's context
// into the next.
//
//   app.user_id — the row owner allowed to see their own rows
//   app.bypass  — "on" for privileged, already-authorized cross-tenant work
//                 (platform aggregates, member recovery, org teardown, workers)
//
// CRUCIAL: the connecting role (wayve_user / rwayve) is a SUPERUSER, which
// bypasses RLS unconditionally. So a user-scoped transaction first sets the GUC
// and then `SET LOCAL ROLE wayve_app` — a restricted, non-superuser role — so
// the policy actually engages. Bypass/privileged paths simply stay the
// superuser (no SET ROLE) and read/write everything. Both the GUC and the role
// are transaction-local and reset on COMMIT/ROLLBACK, so nothing leaks across
// pooled connections.
//
// Policies are deny-by-default: a non-superuser connection with no GUC sees no
// rows. Every access path to an RLS-enabled table must run inside one of the
// helpers below — a missed path is a visible 0-rows bug, never a cross-tenant
// leak. User-private tables (notes, …) use the user_id seam; org-shared tables
// will add an `app.org_id` seam when they are migrated.
// ============================================================================

/// Scope an existing transaction to one user: set `app.user_id` then drop to the
/// restricted `wayve_app` role (see infra/postgres/init.sql) so the RLS policy
/// applies. Both are transaction-local.
pub async fn apply_rls_user(
    tx: &mut Transaction<'_, Postgres>,
    user_id: i32,
) -> Result<(), AppError> {
    sqlx::query("SELECT set_config('app.user_id', $1, true)")
        .bind(user_id.to_string())
        .execute(&mut **tx)
        .await?;
    // Drop superuser so RLS engages. The role name is a fixed constant (no
    // injection); SET ROLE cannot be parameterized.
    sqlx::query("SET LOCAL ROLE wayve_app")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Set `app.bypass = 'on'` (transaction-local) on an existing transaction — for
/// privileged paths that have already done their own RBAC authorization.
pub async fn apply_rls_bypass(tx: &mut Transaction<'_, Postgres>) -> Result<(), AppError> {
    sqlx::query("SELECT set_config('app.bypass', 'on', true)")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Begin a transaction scoped to one user (`app.user_id`), run the closure, and
/// commit. For user-private tables where a handler only touches the caller's
/// own rows. The transaction is the request's pinned connection.
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

/// Begin a transaction in bypass mode (privileged cross-tenant), run the
/// closure, and commit. Only for paths that have done their own authorization.
/// (Most call sites use the inline `apply_rls_bypass` instead; kept for symmetry.)
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
