//! Per-account encryption policy.
//!
//! Standard server-side encryption means the server holds the key and can read
//! the content at rest, which lets it be searched, imported and audited
//! server-side. End-to-end means the server only sees an opaque client envelope.
//!
//! - Chat: every organization and platform account uses standard encryption
//!   ([`chat_uses_standard_encryption`]); personal accounts stay end-to-end.
//! - Email: only enterprise-tier organizations use standard encryption
//!   ([`uses_standard_encryption`]); everyone else stays end-to-end.
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

/// True when `user_id`'s chat uses standard, server-readable encryption instead
/// of E2E: every organization (enterprise or not) and platform account. Sending
/// then never waits on a recipient's published key, and channels, which are
/// always public in these scopes, stay readable to members who join later.
/// Personal accounts keep E2E. Email is unaffected and still follows
/// [`uses_standard_encryption`]. Fails closed: a lookup error keeps E2E.
pub async fn chat_uses_standard_encryption(pool: &PgPool, user_id: i32) -> bool {
    match wayve_security::rbac::resolve_role_context(pool, user_id).await {
        Ok(ctx) if ctx.scope != wayve_security::rbac::Scope::Personal => true,
        Ok(_) => uses_standard_encryption(pool, user_id).await,
        Err(_) => false,
    }
}
