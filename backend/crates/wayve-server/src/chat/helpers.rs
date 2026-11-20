use sqlx::{PgConnection, PgExecutor};
use wayve_security::rbac::{Role, RoleContext, Scope};

// Channel admin invariant: a channel that has members always has at least one
// admin. Every membership or role change runs in a transaction that first takes
// `lock_channel`, so two admins acting at once are serialized and the
// `strands_channel` check sees the other's committed change. Account deletion,
// which bypasses these handlers, is covered by the `users` delete trigger in
// init.sql, which hands admin and creator off to a remaining member.

/// A channel always has fewer than 25 members. Enforced twice: these handler
/// checks give a clear error, and the `trg_channel_member_cap` trigger in
/// init.sql rejects any insert past it, whatever path or race it comes from.
/// Keep the two numbers (and `CHANNEL_MEMBER_CAP_CONSTRAINT`) in sync.
pub const MAX_CHANNEL_MEMBERS: i64 = 24;

/// The constraint name the trigger raises, so a lost race maps to the same
/// "channel is full" error as the up-front check.
pub const CHANNEL_MEMBER_CAP_CONSTRAINT: &str = "channel_members_max_24";

pub const CHANNEL_FULL: &str = "A channel can have at most 24 members.";

/// Whether adding `user_ids` to `channel_id` would take it past
/// [`MAX_CHANNEL_MEMBERS`]. Ids already in the channel don't count, and
/// duplicates count once. Call under `lock_channel` so the count can't move.
pub async fn would_exceed_member_cap(
    conn: &mut PgConnection,
    channel_id: i32,
    user_ids: &[i32],
) -> Result<bool, sqlx::Error> {
    let mut ids = user_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let (current, already): (i64, i64) = sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE user_id = ANY($2)) \
         FROM channel_members WHERE channel_id = $1",
    )
    .bind(channel_id)
    .bind(&ids)
    .fetch_one(conn)
    .await?;
    Ok(current + (ids.len() as i64 - already) > MAX_CHANNEL_MEMBERS)
}

/// Whether `e` is the member-cap trigger rejecting an insert.
pub fn is_member_cap_violation(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(db) if db.constraint() == Some(CHANNEL_MEMBER_CAP_CONSTRAINT))
}

/// The response for a full channel.
pub fn channel_full() -> actix_web::HttpResponse {
    actix_web::HttpResponse::Conflict().json(serde_json::json!({
        "error": CHANNEL_FULL,
        "max_members": MAX_CHANNEL_MEMBERS,
    }))
}

/// Whether the caller's effective (mode-downscoped) role may recover channels
/// in their tenant. Normal mode downscopes to `Member`, so in practice this is
/// an org or platform owner in admin mode.
pub fn is_tenant_admin(ctx: &RoleContext) -> bool {
    ctx.scope != Scope::Personal && matches!(ctx.role, Role::Owner | Role::SuperAdmin | Role::Admin)
}

/// Whether `ctx` may manage `channel_id`: the caller is one of its admins, or
/// the channel has no admin left and the caller is a tenant admin of the
/// tenant the channel belongs to (the recovery path). A tenant admin gets no
/// say over a channel that still has an admin, so private channels stay
/// private to their members. Tenant matching reuses `VISIBLE_CHANNELS`, so a
/// channel is recoverable exactly when it is listable.
pub async fn can_manage_channel<'e, E: PgExecutor<'e>>(
    executor: E,
    ctx: &RoleContext,
    channel_id: i32,
) -> Result<bool, sqlx::Error> {
    let sql = r#"
        SELECT EXISTS(
            SELECT 1 FROM channel_members
            WHERE channel_id = $4 AND user_id = $1 AND role = 'admin'
        )
        OR (
            $5
            AND NOT EXISTS(
                SELECT 1 FROM channel_members WHERE channel_id = $4 AND role = 'admin'
            )
            AND EXISTS(
                SELECT 1
                FROM channels c
                JOIN users creator ON creator.id = c.created_by
                LEFT JOIN channel_members mine
                    ON mine.channel_id = c.id AND mine.user_id = $1
                LEFT JOIN channel_join_requests jr
                    ON jr.channel_id = c.id AND jr.user_id = $1 AND jr.status = 'pending'
                WHERE c.id = $4 AND "#
        .to_string()
        + crate::directory_scope::VISIBLE_CHANNELS
        + r#"
            )
        )
    "#;
    sqlx::query_scalar::<_, bool>(&sql)
        .bind(ctx.user_id)
        .bind(ctx.scope.as_str())
        .bind(ctx.organization_id)
        .bind(channel_id)
        .bind(is_tenant_admin(ctx))
        .fetch_one(executor)
        .await
}

/// Row-lock the channel for the rest of the transaction, serializing every
/// membership and role change on it. `false` when the channel doesn't exist.
pub async fn lock_channel(conn: &mut PgConnection, channel_id: i32) -> Result<bool, sqlx::Error> {
    let found = sqlx::query_scalar::<_, i32>("SELECT id FROM channels WHERE id = $1 FOR UPDATE")
        .bind(channel_id)
        .fetch_optional(conn)
        .await?;
    Ok(found.is_some())
}

/// Whether taking admin away from `target_user_id` would leave members with no
/// admin. `removing` is true when the target leaves the channel entirely (a
/// last member may go, emptying it) and false for a demotion (the target stays
/// on as a member, so there must be another admin). Call under `lock_channel`.
pub async fn strands_channel(
    conn: &mut PgConnection,
    channel_id: i32,
    target_user_id: i32,
    removing: bool,
) -> Result<bool, sqlx::Error> {
    let (other_admins, other_members) = sqlx::query_as::<_, (i64, i64)>(
        "SELECT COUNT(*) FILTER (WHERE role = 'admin'), COUNT(*)
         FROM channel_members WHERE channel_id = $1 AND user_id <> $2",
    )
    .bind(channel_id)
    .bind(target_user_id)
    .fetch_one(conn)
    .await?;
    Ok(other_admins == 0 && (other_members > 0 || !removing))
}

pub fn normalize_invite_emails(emails: &[String]) -> Vec<String> {
    let mut emails = emails
        .iter()
        .map(|email| email.trim().to_lowercase())
        .filter(|email| !email.is_empty())
        .collect::<Vec<_>>();
    emails.sort();
    emails.dedup();
    emails
}

pub fn normalize_channel_role(role: Option<&str>) -> &'static str {
    match role {
        Some("admin") => "admin",
        _ => "user",
    }
}

/// The visibility a channel gets in `scope`. Organization (including
/// enterprise) and platform channels are always public within their tenant, so
/// any member can find and join them.
///
/// A personal account chooses. Its public channel can be joined by any other
/// personal account that has the channel's number, so public has to be asked
/// for by name: anything else, including no choice at all, is private.
pub fn channel_visibility_for(scope: Scope, requested: Option<&str>) -> &'static str {
    if scope != Scope::Personal {
        return "public";
    }
    match requested {
        Some("public") => "public",
        _ => "private",
    }
}
