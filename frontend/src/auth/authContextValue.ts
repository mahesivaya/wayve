import { createContext } from "react";
import type { AccountType } from "./accountHome";

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
};

export type AuthType = {
  user: UserType | null;
  initializing: boolean;
  login: (token: string, accountType?: string) => void;
  logout: () => void;
};

export const AuthContext = createContext<AuthType | null>(null);
