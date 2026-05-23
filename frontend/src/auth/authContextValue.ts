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
  amount_cents: number;
};

// Recovery mode chosen at signup. Surfaced by /api/me so the SPA can
// branch setupEncryption.
//   basic           → server holds an AES_KEY-encrypted copy of the
//                     RSA private key (cross-device login, server-trust)
//   full            → server stores a mnemonic-wrapped envelope of the
//                     real private key (cross-device via /recover)
//   password_only   → server holds only a credential blob (mnemonic
//                     unlocks password reset, encrypted history is
//                     device-bound)
export type RecoveryMode = "basic" | "full" | "password_only";

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
};

export type AuthType = {
  user: UserType | null;
  initializing: boolean;
  login: (token: string, accountType?: string) => void;
  logout: () => void;
};

export const AuthContext = createContext<AuthType | null>(null);
