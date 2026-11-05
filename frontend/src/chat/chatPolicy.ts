import { resolveScope } from "../auth/permissions";

type ChatPolicyUser = {
  scope?: string | null;
  account_type?: string | null;
  current_plan?: { tier?: string | null } | null;
};

// Organization (including enterprise) and platform channels are always public
// within their tenant, so those users get no visibility choice. Only personal
// accounts can keep a channel private. Mirrors the backend's
// chat::helpers::channel_visibility_for, which is the real rule.
export function channelsAlwaysPublic(
  user: ChatPolicyUser | null | undefined
): boolean {
  if (!user) return false;
  const scope = resolveScope(user);
  return scope === "organization" || scope === "platform";
}

// Organization and platform chat uses standard server-side encryption, so new
// messages go out as text and never wait on a recipient's key. Personal accounts
// stay end-to-end. Mirrors encryption_policy::chat_uses_standard_encryption; the
// server rejects plaintext from anyone it doesn't allow.
export function usesStandardChatEncryption(
  user: ChatPolicyUser | null | undefined
): boolean {
  return (
    channelsAlwaysPublic(user) || user?.current_plan?.tier === "enterprise"
  );
}
