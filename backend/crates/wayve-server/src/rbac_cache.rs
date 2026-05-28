//! Redis-backed implementation of [`wayve_security::rbac::RoleContextCache`].
//!
//! `wayve-security` defines the trait; this crate owns the storage. Installing
//! the cache is a one-shot at startup (`install`), after which every call to
//! [`wayve_security::rbac::resolve_role_context`] checks the cache before
//! falling through to the SQL lookup.
//!
//! Cache layout:
//! - Key:   `rbac:ctx:v1:{user_id}`
//! - Value: JSON `{ "scope": "...", "role": "...", "organization_id": ... }`
//! - TTL:   [`RBAC_TTL_SECS`] seconds (45)
//!
//! The two-layer [`Cache`](crate::cache::Cache) (moka L1 + Redis L2) means
//! tight loops inside the same process don't even cross the network.

use crate::cache::Cache;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tracing::info;
use wayve_security::rbac::{Role, RoleContext, RoleContextCache, Scope, install_cache};

/// 45s sits in the middle of the 30–60s window. Authorization stays
/// "near-realtime" — fresh after a role change because every mutation
/// handler in `routes/user.rs` calls
/// [`wayve_security::rbac::invalidate_role_context`] on commit, and even
/// without invalidation a stale role is corrected within ~45s.
const RBAC_TTL_SECS: u64 = 45;

fn key(user_id: i32) -> String {
    format!("rbac:ctx:v1:{user_id}")
}

#[derive(Serialize, Deserialize)]
struct StoredCtx {
    scope: String,
    role: String,
    organization_id: Option<i32>,
}

impl StoredCtx {
    fn from(ctx: &RoleContext) -> Self {
        Self {
            scope: ctx.scope.as_str().to_string(),
            role: ctx.role.as_str().to_string(),
            organization_id: ctx.organization_id,
        }
    }

    fn into_ctx(self, user_id: i32) -> RoleContext {
        RoleContext {
            user_id,
            scope: parse_scope(&self.scope),
            role: Role::from_str(&self.role),
            organization_id: self.organization_id,
        }
    }
}

fn parse_scope(value: &str) -> Scope {
    match value {
        "platform" => Scope::Platform,
        "organization" => Scope::Organization,
        _ => Scope::Personal,
    }
}

struct RedisRoleContextCache {
    cache: Cache,
}

#[async_trait]
impl RoleContextCache for RedisRoleContextCache {
    async fn get(&self, user_id: i32) -> Option<RoleContext> {
        let stored: Option<StoredCtx> = self.cache.get_json(&key(user_id)).await;
        stored.map(|s| s.into_ctx(user_id))
    }

    async fn put(&self, user_id: i32, ctx: &RoleContext) {
        let stored = StoredCtx::from(ctx);
        self.cache
            .set_json_with_ttl(&key(user_id), &stored, RBAC_TTL_SECS)
            .await;
    }

    async fn invalidate(&self, user_id: i32) {
        self.cache.del(&key(user_id)).await;
    }
}

/// Install the Redis-backed RoleContext cache. No-op when Redis is
/// unavailable so the app keeps serving authorization off the DB.
pub fn install(cache: Option<Cache>) {
    if let Some(cache) = cache {
        install_cache(Box::new(RedisRoleContextCache { cache }));
        info!(target: "auth", ttl_secs = RBAC_TTL_SECS, "RBAC role-context cache installed");
    }
}
