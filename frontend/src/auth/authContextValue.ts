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

export type UserType = {
  email: string;
  id: number;
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
};

export type AuthType = {
  user: UserType | null;
  initializing: boolean;
  login: (token: string, accountType?: string) => void;
  logout: () => void;
};

export const AuthContext = createContext<AuthType | null>(null);
