//! Per-organization encryption policy.
//!
//! Enterprise-tier organizations use **standard** server-side encryption — the
//! server holds the key and can read the content (chat messages, email bodies)
//! at rest — instead of end-to-end. That is what lets enterprise data be
//! processed server-side (search, external imports, compliance). Every other
//! account stays end-to-end: the server only ever sees an opaque client
//! envelope it cannot open.
//!
//! The check is **always** resolved from the DB and never trusted from the
//! client, and it keys off `plans.tier = 'enterprise'` (see the per-plan tier
//! discriminator). A lookup failure or an unknown tier fails **closed** —
//! `false`, i.e. keep E2E — so a transient error can never silently downgrade a
//! user out of end-to-end encryption.

use crate::prelude::*;

/// True when `user_id` belongs to an organization whose active subscription is
/// on the enterprise tier, i.e. their chat + email should use standard
/// (server-readable) encryption rather than E2E.
///
/// Fails closed: returns `false` (keep E2E) on any error or for any
/// non-enterprise user.
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
