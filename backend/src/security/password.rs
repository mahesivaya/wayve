//! Bcrypt-based password hashing and verification.
//!
//! Both operations are deliberately CPU-heavy (`DEFAULT_COST = 12` ≈
//! 100–300 ms on a typical server). Calling them inline from an `async fn`
//! pins the tokio worker thread for that whole window — under any
//! concurrent-login burst, the runtime stops servicing other requests.
//!
//! These helpers forward the work to [`tokio::task::spawn_blocking`], which
//! runs it on tokio's separate blocking pool so the async workers stay free.
//! The calling task is suspended at the `.await` until the result is ready,
//! so handler control flow is unchanged.

use crate::error::AppError;
use bcrypt::{DEFAULT_COST, hash, verify};

/// Hash `plaintext` with bcrypt at the default cost, off the async runtime.
pub async fn hash_password(plaintext: &str) -> Result<String, AppError> {
    let plaintext = plaintext.to_owned();
    tokio::task::spawn_blocking(move || hash(&plaintext, DEFAULT_COST))
        .await
        .map_err(|e| AppError::Internal(format!("bcrypt hash join failed: {e}")))?
        .map_err(|e| AppError::Internal(format!("bcrypt hash failed: {e}")))
}

/// Verify `plaintext` against the stored bcrypt `hashed`, off the async runtime.
pub async fn verify_password(plaintext: &str, hashed: &str) -> Result<bool, AppError> {
    let plaintext = plaintext.to_owned();
    let hashed = hashed.to_owned();
    tokio::task::spawn_blocking(move || verify(&plaintext, &hashed))
        .await
        .map_err(|e| AppError::Internal(format!("bcrypt verify join failed: {e}")))?
        .map_err(|e| AppError::Internal(format!("bcrypt verify failed: {e}")))
}
