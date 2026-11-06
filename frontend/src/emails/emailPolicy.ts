import { resolveScope } from "../auth/permissions";

type EmailPolicyUser = {
  scope?: string | null;
  account_type?: string | null;
};

// Organization (including enterprise) and platform accounts send email with
// basic encryption only: a standard email to the recipient's mailbox, encrypted
// at rest on the server. The compose form leaves out End-to-End, Fluxze-only
// and Secure send for them. Personal accounts keep all three.
export function emailBasicEncryptionOnly(
  user: EmailPolicyUser | null | undefined
): boolean {
  if (!user) return false;
  const scope = resolveScope(user);
  return scope === "organization" || scope === "platform";
}
