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
