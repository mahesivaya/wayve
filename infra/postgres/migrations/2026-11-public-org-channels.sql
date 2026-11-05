-- Organization (including enterprise) and platform channels are now always
-- public within their tenant; only personal accounts may keep one private (see
-- chat::helpers::channel_visibility_for). This opens up the private channels that
-- already exist in those scopes. A channel's scope is its creator's, resolved the
-- same way as rbac::resolve_role_context: platform when account_type is
-- 'platform_admin', organization when the user has an organization_id.
--
-- Messages already sent in these channels stay end-to-end encrypted for the
-- members they were sent to, so someone who joins later can't read them. New
-- messages use standard encryption and are readable to every member.
--
-- Idempotent.
UPDATE channels c
   SET visibility = 'public'
  FROM users creator
 WHERE creator.id = c.created_by
   AND c.visibility <> 'public'
   AND (creator.account_type = 'platform_admin' OR creator.organization_id IS NOT NULL);
