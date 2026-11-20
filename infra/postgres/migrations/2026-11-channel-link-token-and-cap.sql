-- Channel links carry a secret, and every channel is capped at 24 members.
--
-- 1. channels.link_token: a personal account's public channel is now reachable
--    only through its link (`/chat?c=<id>&t=<link_token>`), never by its
--    sequential id alone (chat::channel_join::MAY_REACH). Every existing channel
--    gets its own random token here, so links copied before this change stop
--    working for non-members; members get the new link from the channel list.
-- 2. The 24-member cap trigger from #389, which init.sql gained without a
--    migration. Existing channels over the cap keep their members; they just
--    can't grow.
--
-- Idempotent. Requires Postgres 14+ (CREATE OR REPLACE TRIGGER).
BEGIN;

ALTER TABLE channels ADD COLUMN IF NOT EXISTS link_token TEXT NOT NULL
    DEFAULT replace(gen_random_uuid()::text, '-', '');

CREATE OR REPLACE FUNCTION wayve_channel_member_cap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM 1 FROM channels WHERE id = NEW.channel_id FOR NO KEY UPDATE;
    IF (SELECT count(*) FROM channel_members
         WHERE channel_id = NEW.channel_id AND user_id <> NEW.user_id) >= 24 THEN
        RAISE EXCEPTION 'channel % is full: a channel can have at most 24 members',
            NEW.channel_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'channel_members_max_24';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_channel_member_cap
    BEFORE INSERT ON channel_members
    FOR EACH ROW EXECUTE FUNCTION wayve_channel_member_cap();

COMMIT;
