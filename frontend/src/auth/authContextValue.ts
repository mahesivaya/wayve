import { createContext } from "react";
import type { AccountType } from "./accountHome";

// The user's current tier, from /api/me. The backend falls back to the
// `basic_user` plan when no subscription is active, so this is almost always
// present for an authenticated user.
export type CurrentPlan = {
  code: string;
  name: string;
  audience: string;
  // Sub-tier: "personal" | "startups" | "business" | "enterprise", or "none"
  // for an organization with no active subscription.
  tier: string;
  amount_cents: number;
};

// Only one recovery mode exists. Every user's RSA private key is wrapped by
// their 24-word BIP-39 mnemonic and the server stores only the opaque envelope.
// The union survives as a one-inhabitant type so the rest of the SPA compiles;
// legacy 'basic' and 'password_only' rows were migrated to 'full'.
export type RecoveryMode = "full";

export type UserType = {
  email: string;
  id: number;
  // Null when the user signed up via OAuth without setting one. Cosmetic only,
  // never load-bearing.
  username?: string | null;
  account_type: AccountType;
  effective_role?: string | null;
  role_label?: string | null;
  // RBAC scope ("personal" | "organization" | "platform") and the resolved
  // permissions. Server-computed, and for UI gating only.
  scope?: string | null;
  permissions?: string[];
  // True only for the FIRST owner of an organization. Gates single-owner
  // affordances such as connecting the org's own OAuth mailbox, and is always
  // false in personal and platform scopes.
  is_primary_owner?: boolean;
  // An owner logs in as "normal", a downscoped identity, and can switch to
  // "admin" to reach the admin console. Absent means "normal". Comes from the
  // JWT claim, so it is server-authoritative.
  mode?: "normal" | "admin";
  // True when the caller's true, pre-downscope role is an org or platform owner
  // and they may therefore enter admin mode. Stays visible while downscoped,
  // which is what drives the switcher.
  can_switch_admin?: boolean;
  organization_id?: number | null;
  organization_slug?: string | null;
  organization_name?: string | null;
  current_plan?: CurrentPlan | null;
  // Defaults to "full" when /api/me predates the column (legacy rows).
  recovery_mode?: RecoveryMode;
  // Serialized ThemeChoice, an opaque JSON string whose schema the theme module
  // owns. Absent means no server-side override, so the client falls back to its
  // localStorage cache or the default.
  theme_json?: string | null;
  // True means this user's chat attachments are end-to-end encrypted and the
  // server cannot read them; false means server-encrypted at rest only.
  chat_encrypt_files?: boolean;
  // Minutes before a meeting starts that the alert popup fires; 0 means meeting
  // alerts are off. Absent on responses predating the column — treat as 10.
  meeting_alert_minutes?: number;
};

export type AuthType = {
  user: UserType | null;
  initializing: boolean;
  // `isFreshRegistration` flips the encryption-setup path: only the register flow
  // generates new keys and shows the 24-word seed modal. A regular login leaves
  // the server's wrapped envelope alone, and if local keys are missing the user
  // recovers via /recover-with-mnemonic instead.
  //
  // `plaintextPassword` is forwarded once to setupEncryption so it can build the
  // PBKDF2 login-wrap that lets the user auto-unlock on a new browser. SSO and
  // Google paths omit it.
  login: (
    token: string,
    accountType?: string,
    isFreshRegistration?: boolean,
    plaintextPassword?: string
  ) => void;
  logout: () => void;
  // Called after server-side mutations that change the caller's scope or
  // permissions, such as a personal user creating an organization and being
  // promoted to organization_admin.
  refresh: () => Promise<void>;
  // Rejects if the server refuses, for example a non-owner requesting admin.
  switchMode: (target: "normal" | "admin") => Promise<void>;
};

export const AuthContext = createContext<AuthType | null>(null);
