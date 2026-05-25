// SCIM bearer token issuance + lookup.
//
// A raw `wv_scim_<48 hex>` token is shown once at creation. We store only
// its SHA-256 hash + a redacted preview for the dashboard. Lookup is one
// indexed query, identical pattern to `api_keys.key_hash`.

use crate::prelude::*;
use rand::RngCore;
use sha2::Digest;

/// Resolved identity of a SCIM caller — the organization the token belongs
/// to. Handlers scope every query through this id.
#[derive(Debug, Clone)]
pub struct ScimPrincipal {
    /// For log correlation; not consumed yet.
    #[allow(dead_code)]
    pub token_id: i32,
    pub organization_id: i32,
}

pub fn generate() -> (String, String, String) {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    let raw = format!(
        "wv_scim_{}",
        bytes.iter().fold(String::new(), |mut acc, b| {
            acc.push_str(&format!("{b:02x}"));
            acc
        }),
    );
    let preview = format!("{}…{}", &raw[..12], &raw[raw.len() - 4..]);
    let hash = sha256_hex(&raw);
    (raw, hash, preview)
}

pub fn sha256_hex(raw: &str) -> String {
    let mut hasher = sha2::Sha256::new();
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();
    digest.iter().fold(String::new(), |mut acc, b| {
        acc.push_str(&format!("{b:02x}"));
        acc
    })
}

/// Look up a presented bearer token. Returns the principal if the token
/// exists and is not revoked. `last_used_at` is stamped best-effort.
pub async fn resolve(pool: &PgPool, raw: &str) -> Option<ScimPrincipal> {
    let hash = sha256_hex(raw);
    let row = sqlx::query(
        "SELECT id, organization_id FROM scim_tokens \
         WHERE token_hash = $1 AND revoked_at IS NULL",
    )
    .bind(&hash)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()?;
    let id: i32 = row.get("id");
    let organization_id: i32 = row.get("organization_id");

    // Fire-and-forget; never block on the stamp.
    let pool_clone = pool.clone();
    tokio::spawn(async move {
        let _ = sqlx::query("UPDATE scim_tokens SET last_used_at = NOW() WHERE id = $1")
            .bind(id)
            .execute(&pool_clone)
            .await;
    });

    Some(ScimPrincipal {
        token_id: id,
        organization_id,
    })
}
