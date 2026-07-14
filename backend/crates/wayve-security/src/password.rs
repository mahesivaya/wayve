//! Bcrypt password hashing and verification.
//!
//! Both operations are deliberately CPU-heavy (100–300 ms at `DEFAULT_COST`).
//! Run inline from an `async fn` they would pin a tokio worker thread for that
//! whole window and stall the runtime under a concurrent-login burst, so these
//! helpers hand the work to [`tokio::task::spawn_blocking`].

use bcrypt::{BcryptError, DEFAULT_COST, hash, verify};

/// The `spawn_blocking` join error and the underlying `bcrypt` error in one
/// type. Deliberately not an application-level error, to keep this crate free of
/// the consumer crate's taxonomy.
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
