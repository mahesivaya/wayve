-- ============================================================================
-- Chat channel admin handoff on account deletion (+ one-time backfill).
--
-- Adds a BEFORE DELETE trigger on users that promotes a successor when the
-- deleted user was a channel's last admin, and reassigns channels.created_by
-- so deleting a channel's creator no longer cascades the whole channel away.
-- Then backfills an admin into every channel that has members but no admin.
-- Mirrors the block in init.sql. The handler-side fixes (row lock, no demotion
-- via "add", role endpoint, leave endpoint, owner recovery) ship with the
-- backend; this file is only the database half.
--
-- Idempotent + safe to re-run. Apply by hand (init.sql only runs on a fresh
-- volume). Preview what the backfill will touch first:
--   SELECT c.id, c.name FROM channels c
--   WHERE EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id)
--     AND NOT EXISTS (SELECT 1 FROM channel_members a
--                     WHERE a.channel_id = c.id AND a.role = 'admin');
-- Dev:
--   docker exec -i rwayve_postgres_dev psql -U wayve_user -d wayve_dev \
--     < infra/postgres/migrations/2026-09-channel-admin-handoff.sql
-- Prod:
--   ssh ... 'docker exec -i rwayve_postgres_prod sh -c \
--     "psql -v ON_ERROR_STOP=1 -U \$POSTGRES_USER -d \$POSTGRES_DB"' \
--     < infra/postgres/migrations/2026-09-channel-admin-handoff.sql
--
-- Rollback (the backfilled admin roles are not reverted):
--   DROP TRIGGER IF EXISTS trg_channel_handoff_on_user_delete ON users;
--   DROP FUNCTION IF EXISTS wayve_channel_handoff_on_user_delete();
--   DROP FUNCTION IF EXISTS wayve_same_tenant(TEXT, INT, TEXT, INT);
-- ============================================================================

BEGIN;

-- Channel admin invariant: a channel with members always has an admin. The chat
-- handlers enforce it under a channel row lock (chat/helpers.rs); account
-- deletion bypasses them, since channel_members rows vanish by ON DELETE
-- CASCADE. So before a user row is deleted, this trigger hands off:
--   * admin: if they are a channel's last admin, the best remaining member is
--     promoted;
--   * creator: channels.created_by is reassigned to the best remaining member.
--     The creator decides which tenant sees the channel (directory_scope.rs),
--     and the FK is ON DELETE CASCADE, so leaving it would delete the channel
--     and every message in it for everyone else.
-- "Best" prefers the channel's own tenant (so it stays visible where it was),
-- then existing admins, then the longest-standing member. Only rows whose user
-- still exists count, so a multi-row DELETE hands off correctly: rows deleted
-- earlier in the same statement are already gone from `users`, though their
-- cascaded channel_members rows linger until the statement ends. A channel with
-- no remaining member keeps no successor and cascades away as before.
CREATE OR REPLACE FUNCTION wayve_same_tenant(a_type TEXT, a_org INT, b_type TEXT, b_org INT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN a_type = 'platform_admin' THEN b_type = 'platform_admin'
        WHEN a_type IN ('organization', 'organization_admin')
            THEN b_type IN ('organization', 'organization_admin')
             AND a_org IS NOT DISTINCT FROM b_org
        ELSE b_type = 'personal'
    END
$$;

CREATE OR REPLACE FUNCTION wayve_channel_handoff_on_user_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    ch RECORD;
    successor INT;
    successor_is_admin BOOLEAN;
BEGIN
    FOR ch IN
        SELECT c.id,
               c.created_by = OLD.id AS is_creator,
               EXISTS (
                   SELECT 1 FROM channel_members me
                   WHERE me.channel_id = c.id AND me.user_id = OLD.id AND me.role = 'admin'
               ) AS is_admin,
               creator.account_type AS creator_type,
               creator.organization_id AS creator_org
        FROM channels c
        JOIN users creator ON creator.id = c.created_by
        WHERE c.created_by = OLD.id
           OR EXISTS (
               SELECT 1 FROM channel_members me
               WHERE me.channel_id = c.id AND me.user_id = OLD.id AND me.role = 'admin'
           )
        FOR UPDATE OF c
    LOOP
        SELECT cm.user_id, cm.role = 'admin'
          INTO successor, successor_is_admin
        FROM channel_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.channel_id = ch.id AND cm.user_id <> OLD.id
        ORDER BY wayve_same_tenant(ch.creator_type, ch.creator_org, u.account_type, u.organization_id) DESC,
                 cm.role = 'admin' DESC,
                 cm.joined_at,
                 cm.user_id
        LIMIT 1;

        CONTINUE WHEN successor IS NULL;

        IF ch.is_admin AND NOT EXISTS (
            SELECT 1 FROM channel_members a
            JOIN users au ON au.id = a.user_id
            WHERE a.channel_id = ch.id AND a.user_id <> OLD.id AND a.role = 'admin'
        ) THEN
            UPDATE channel_members SET role = 'admin'
            WHERE channel_id = ch.id AND user_id = successor;
        END IF;

        IF ch.is_creator THEN
            UPDATE channels SET created_by = successor WHERE id = ch.id;
        END IF;
    END LOOP;
    RETURN OLD;
END;
$$;

CREATE OR REPLACE TRIGGER trg_channel_handoff_on_user_delete
    BEFORE DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION wayve_channel_handoff_on_user_delete();

-- Backfill: channels that already lost every admin (the old "re-add as member"
-- self-demotion, or deleted admins) get one by the same rule, preferring the
-- creator if they are still a member. Idempotent: it only touches channels
-- that have members and no admin.
UPDATE channel_members cm
SET role = 'admin'
FROM (
    SELECT DISTINCT ON (c.id) c.id AS channel_id, m.user_id
    FROM channels c
    JOIN users creator ON creator.id = c.created_by
    JOIN channel_members m ON m.channel_id = c.id
    JOIN users u ON u.id = m.user_id
    WHERE NOT EXISTS (
        SELECT 1 FROM channel_members a WHERE a.channel_id = c.id AND a.role = 'admin'
    )
    ORDER BY c.id,
             m.user_id = c.created_by DESC,
             wayve_same_tenant(creator.account_type, creator.organization_id, u.account_type, u.organization_id) DESC,
             m.joined_at,
             m.user_id
) pick
WHERE cm.channel_id = pick.channel_id AND cm.user_id = pick.user_id;

COMMIT;
