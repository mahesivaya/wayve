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
//!
//! Returns `BcryptError` rather than an application-level `AppError` so this
//! crate stays free of the consumer crate's error taxonomy. Callers map
//! into their own error type at the boundary.

use bcrypt::{BcryptError, DEFAULT_COST, hash, verify};

/// Wraps the `tokio::task::spawn_blocking` `JoinError` plus the underlying
/// `bcrypt` error in a single type the caller can pattern-match on if it
/// cares to. Most callers will just propagate.
#[derive(Debug, thiserror::Error)]
pub enum PasswordError {
    #[error("bcrypt failed: {0}")]
    Bcrypt(#[from] BcryptError),
    #[error("blocking task join failed: {0}")]
    Join(#[from] tokio::task::JoinError),
}

/// Hash `plaintext` with bcrypt at the default cost, off the async runtime.
pub async fn hash_password(plaintext: &str) -> Result<String, PasswordError> {
    let plaintext = plaintext.to_owned();
    let hashed = tokio::task::spawn_blocking(move || hash(&plaintext, DEFAULT_COST)).await??;
    Ok(hashed)
}

/// Verify `plaintext` against the stored bcrypt `hashed`, off the async runtime.
pub async fn verify_password(plaintext: &str, hashed: &str) -> Result<bool, PasswordError> {
    let plaintext = plaintext.to_owned();
    let hashed = hashed.to_owned();
    let ok = tokio::task::spawn_blocking(move || verify(&plaintext, &hashed)).await??;
    Ok(ok)
}
