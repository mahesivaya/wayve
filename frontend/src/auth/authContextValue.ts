import { createContext } from "react";
import type { AccountType } from "./accountHome";

// Snapshot of the user's current tier — returned by /api/me (and /api/profile)
// from `routes/user.rs::current_plan_for_user`. Falls back to the
// `basic_user` plan when no active subscription exists, so this field is
// almost always present for an authenticated user.
export type CurrentPlan = {
  code: string;
  name: string;
  audience: string;
  // Sub-tier: "personal" | "startups" | "business" | "enterprise", or "none"
  // for an organization with no active subscription.
  tier: string;
  amount_cents: number;
};

// Plan A: only one recovery mode exists — 'full'. Every user's RSA
// private key is wrapped by their 24-word BIP-39 mnemonic; the server
// stores only the opaque envelope. The string union still exists as a
// type so the rest of the SPA compiles unchanged, but it has exactly
// one inhabitant. The legacy 'basic' and 'password_only' rows have
// been migrated to 'full' (see infra/postgres/init.sql and
// backend/.../startup.rs).
export type RecoveryMode = "full";

export type UserType = {
  email: string;
  id: number;
  // Optional handle — backend returns `Option<String>` from /api/me and
  // /api/profile. Null when the user signed up via OAuth without setting one
  // (or hasn't been migrated). Used in places like Support.tsx for cosmetic
  // gating; never load-bearing.
  username?: string | null;
  account_type: AccountType;
  effective_role?: string | null;
  role_label?: string | null;
  // RBAC scope ("personal" | "organization" | "platform") and the resolved
  // permission strings — server-computed, used to gate UI.
  scope?: string | null;
  permissions?: string[];
  organization_id?: number | null;
  organization_slug?: string | null;
  organization_name?: string | null;
  current_plan?: CurrentPlan | null;
  // Defaults to "full" when /api/me predates the column (legacy rows).
  recovery_mode?: RecoveryMode;
  // Serialized ThemeChoice from the theme customizer. Opaque JSON string;
  // the theme module owns the schema. NULL/undefined means no server-side
  // override, so the client uses its localStorage cache or the default.
  theme_json?: string | null;
  // When true, chat file attachments this user sends are end-to-end encrypted
  // (server can't read them); false = server-encrypted at rest only. Toggled in
  // Settings by personal accounts and owners. Defaults true.
  chat_encrypt_files?: boolean;
};

export type AuthType = {
  user: UserType | null;
  initializing: boolean;
  // `isFreshRegistration` flips the encryption-setup path. Only the
  // register flow generates new keys + shows the 24-word seed modal.
  // Regular login leaves the server's wrapped envelope alone — if local
  // keys are missing, the user recovers via /recover-with-mnemonic.
  // `plaintextPassword`, when supplied, is forwarded once to
  // setupEncryption so the post-login flow can also produce a PBKDF2
  // login-wrap for the personal user (auto-unlock on new browsers,
  // skip the mnemonic prompt). Optional — SSO/Google paths omit it.
  login: (
    token: string,
    accountType?: string,
    isFreshRegistration?: boolean,
    plaintextPassword?: string
  ) => void;
  logout: () => void;
  // Re-fetch /api/me and update user state. Called after server-side
  // mutations that change the caller's scope/permissions (e.g. a personal
  // user creating an organization and being promoted to organization_admin).
  refresh: () => Promise<void>;
};

export const AuthContext = createContext<AuthType | null>(null);
