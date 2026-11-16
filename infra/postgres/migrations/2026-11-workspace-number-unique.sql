-- Story and ticket numbers are a per-owner sequence (MAX(number) + 1 at
-- create). Concurrent creates could take the same number; the handlers now
-- serialize per owner (tasks::statuses::lock_owner_sequence), and these unique
-- indexes back that up.
--
-- Existing duplicates are renumbered first, or the indexes can't be built: in
-- each set of rows sharing an owner and number, the earliest (lowest id) keeps
-- it and the later ones move past the owner's current highest number, in id
-- order. Rows with no number (bug tickets mirrored from support reports) are
-- untouched; the indexes ignore them.
--
-- Idempotent: with no duplicates the updates change nothing.

BEGIN;

WITH numbered AS (
    SELECT id, COALESCE(organization_id, 0) AS org, COALESCE(user_id, 0) AS usr,
           ROW_NUMBER() OVER (PARTITION BY organization_id, user_id, story_number
                              ORDER BY id) AS copy
      FROM user_stories
     WHERE story_number IS NOT NULL),
dups AS (
    SELECT id, org, usr, ROW_NUMBER() OVER (PARTITION BY org, usr ORDER BY id) AS k
      FROM numbered WHERE copy > 1),
top AS (
    SELECT COALESCE(organization_id, 0) AS org, COALESCE(user_id, 0) AS usr,
           MAX(story_number) AS n
      FROM user_stories GROUP BY 1, 2)
UPDATE user_stories s
   SET story_number = top.n + dups.k
  FROM dups JOIN top USING (org, usr)
 WHERE s.id = dups.id;

WITH numbered AS (
    SELECT id, COALESCE(organization_id, 0) AS org, COALESCE(user_id, 0) AS usr,
           ROW_NUMBER() OVER (PARTITION BY organization_id, user_id, ticket_number
                              ORDER BY id) AS copy
      FROM workspace_tickets
     WHERE ticket_number IS NOT NULL),
dups AS (
    SELECT id, org, usr, ROW_NUMBER() OVER (PARTITION BY org, usr ORDER BY id) AS k
      FROM numbered WHERE copy > 1),
top AS (
    SELECT COALESCE(organization_id, 0) AS org, COALESCE(user_id, 0) AS usr,
           MAX(ticket_number) AS n
      FROM workspace_tickets GROUP BY 1, 2)
UPDATE workspace_tickets t
   SET ticket_number = top.n + dups.k
  FROM dups JOIN top USING (org, usr)
 WHERE t.id = dups.id;

-- Each row has exactly one owner (the *_owner_chk constraints), so one partial
-- index per owner kind covers every number.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_stories_org_number
    ON user_stories(organization_id, story_number) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_stories_user_number
    ON user_stories(user_id, story_number) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_tickets_org_number
    ON workspace_tickets(organization_id, ticket_number) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_tickets_user_number
    ON workspace_tickets(user_id, ticket_number) WHERE user_id IS NOT NULL;

COMMIT;
