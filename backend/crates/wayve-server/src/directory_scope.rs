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

/// SQL: whether the `users` row aliased `x` is platform support staff, a
/// platform account whose platform role is `support`. `x` is a trusted alias
/// from the calling query, never user input.
pub fn is_platform_support(x: &str) -> String {
    format!(
        "({x}.account_type = 'platform_admin' AND EXISTS (\
             SELECT 1 FROM platform_members support_pm \
             WHERE support_pm.user_id = {x}.id AND support_pm.role = 'support'))"
    )
}

/// SQL: whether the `users` rows aliased `a` and `b` may exchange direct
/// messages. The rule is symmetric:
///
/// - personal ↔ personal;
/// - organization members ↔ members of the same organization;
/// - platform ↔ platform;
/// - platform support ↔ personal accounts and organization admins (of any
///   organization), so customers can reach support and support can reach them.
///
/// Anything else, such as a personal account and an organization, or a regular
/// organization member and platform support, is refused. Aliases are trusted
/// identifiers from the calling query.
pub fn dm_allowed(a: &str, b: &str) -> String {
    let a_support = is_platform_support(a);
    let b_support = is_platform_support(b);
    format!(
        "(\
            ({a}.account_type = 'personal' AND {b}.account_type = 'personal') \
         OR ({a}.account_type = 'platform_admin' AND {b}.account_type = 'platform_admin') \
         OR ({a}.account_type IN ('organization', 'organization_admin') \
             AND {b}.account_type IN ('organization', 'organization_admin') \
             AND {a}.organization_id = {b}.organization_id) \
         OR ({a_support} AND {b}.account_type IN ('personal', 'organization_admin')) \
         OR ({b_support} AND {a}.account_type IN ('personal', 'organization_admin'))\
        )"
    )
}

/// SQL predicate over `users u` for the chat people list, on top of
/// [`VISIBLE_USERS`] (same `$1` = caller id): people the caller may DM who are
/// either platform support (so customers can find them) or already in a
/// conversation with the caller (so support sees who they are talking to).
pub fn chat_contacts() -> String {
    let allowed = dm_allowed("me", "u");
    let support = is_platform_support("u");
    format!(
        "EXISTS (\
            SELECT 1 FROM users me \
            WHERE me.id = $1 AND me.id <> u.id AND {allowed} \
              AND ({support} OR EXISTS (\
                    SELECT 1 FROM messages dm \
                    WHERE (dm.sender_id = $1 AND dm.receiver_id = u.id) \
                       OR (dm.sender_id = u.id AND dm.receiver_id = $1))))"
    )
}
