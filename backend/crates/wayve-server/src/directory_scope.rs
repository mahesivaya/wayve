//! Shared SQL predicates for tenant-scoped directory and channel listings.
//!
//! Platform and organization accounts form real tenants: every platform admin
//! shares one directory, and an org's members share an `organization_id`.
//! Personal accounts do **not** form a tenant. Matching on
//! `account_type = 'personal'` alone puts every personal signup on the instance
//! into one bucket, so a brand-new account would open the app to a roster of
//! strangers and their channels.
//!
//! Personal visibility is therefore relational rather than categorical: you see
//! the people you actually share a conversation with, and the channels you
//! actually belong to or were invited to.
//!
//! Both fragments assume the same leading bind order, so a query can splice
//! either one in without renumbering the rest:
//!
//! | Placeholder | Value |
//! |---|---|
//! | `$1` | caller's user id |
//! | `$2` | `rbac::RoleContext::scope` as a string |
//! | `$3` | caller's organization id (NULL outside an org) |
//!
//! Additional placeholders in the host query must start at `$4`.

/// Restricts a `users u` row set to what the caller is allowed to enumerate.
///
/// Personal callers see themselves, anyone sharing a channel with them, and
/// anyone they have exchanged a direct message with.
pub const VISIBLE_USERS: &str = r#"(
    ($2 = 'platform'     AND u.account_type = 'platform_admin')
 OR ($2 = 'organization' AND u.account_type IN ('organization', 'organization_admin')
                          AND u.organization_id = $3)
 OR ($2 = 'personal'     AND u.account_type = 'personal' AND (
        u.id = $1
     OR EXISTS (
            SELECT 1
            FROM channel_members mine_cm
            JOIN channel_members their_cm
              ON their_cm.channel_id = mine_cm.channel_id
            WHERE mine_cm.user_id = $1
              AND their_cm.user_id = u.id
        )
     OR EXISTS (
            SELECT 1
            FROM messages dm
            WHERE (dm.sender_id = $1 AND dm.receiver_id = u.id)
               OR (dm.sender_id = u.id AND dm.receiver_id = $1)
        )
    ))
)"#;

/// Restricts a `channels c` row set to what the caller is allowed to list.
///
/// The host query must expose three aliases: `creator` (the channel's author,
/// joined from `users`), `mine` (the caller's `channel_members` row, LEFT
/// JOINed) and `jr` (the caller's pending `channel_join_requests` row, LEFT
/// JOINed).
///
/// Personal callers see only channels they are a member of, created, were
/// invited to by email, or have a pending join request for — public channels
/// from unrelated personal accounts stay hidden, since there is no shared
/// tenant that would make them discoverable.
pub const VISIBLE_CHANNELS: &str = r#"(
    ($2 = 'platform'     AND creator.account_type = 'platform_admin')
 OR ($2 = 'organization' AND creator.account_type IN ('organization', 'organization_admin')
                          AND creator.organization_id = $3)
 OR ($2 = 'personal'     AND creator.account_type = 'personal' AND (
        mine.user_id IS NOT NULL
     OR jr.user_id IS NOT NULL
     OR c.created_by = $1
     OR EXISTS (
            SELECT 1
            FROM channel_invites ci_me
            JOIN users me ON me.id = $1
            WHERE ci_me.channel_id = c.id
              AND lower(ci_me.email) = lower(me.email)
        )
    ))
)"#;
