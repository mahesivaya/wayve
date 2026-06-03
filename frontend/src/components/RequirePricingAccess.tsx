import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { homePathForUser } from "../auth/accountHome";
import { canViewPricing } from "../auth/permissions";

// Route guard for /pricing. The page is public, so logged-out marketing
// visitors pass straight through. Signed-in users are filtered so the URL
// can't bypass the hidden sidebar link:
//   • personal accounts → /settings (where "Manage billing & upgrade" lives);
//   • org/platform roles that don't manage billing (admin, security,
//     developer, support, guest, member) → their account home.
// Only owner / super_admin / billing reach the plan grid.
export default function RequirePricingAccess({
  children,
}: {
  children: ReactNode;
}) {
  const { user } = useAuth();

  if (!user) return <>{children}</>;

  if (user.account_type === "personal") {
    return <Navigate to="/settings" replace />;
  }

  if (!canViewPricing(user)) {
    return <Navigate to={homePathForUser(user)} replace />;
  }

  return <>{children}</>;
}
