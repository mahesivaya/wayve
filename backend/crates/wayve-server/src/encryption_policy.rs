//! Per-organization encryption policy.
//!
//! Enterprise-tier organizations use standard server-side encryption: the server
//! holds the key and can read chat and email content at rest, which is what lets
//! enterprise data be searched, imported, and audited server-side. Every other
//! account stays end-to-end, where the server only sees an opaque client envelope.
//!
//! The check is always resolved from the DB against `plans.tier` and never trusted
//! from the client. A lookup failure or unknown tier fails closed (keeps E2E), so
//! a transient error can never silently downgrade a user out of end-to-end
//! encryption.

use crate::prelude::*;

/// True when `user_id` belongs to an org on the enterprise tier, meaning their
/// chat and email use server-readable encryption rather than E2E. Fails closed.
pub async fn uses_standard_encryption(pool: &PgPool, user_id: i32) -> bool {
    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM users u
            JOIN subscriptions s
              ON s.organization_id = u.organization_id AND s.status = 'active'
            JOIN plans p ON p.id = s.plan_id
            WHERE u.id = $1 AND p.tier = 'enterprise'
        )
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .unwrap_or(false)
}
