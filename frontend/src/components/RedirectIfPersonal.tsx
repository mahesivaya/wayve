import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { homePathForUser } from "../auth/accountHome";

// Route-level guard for surfaces hidden from personal accounts in the nav.
// Logged-out visitors still see the marketing pages (the routes are public),
// and organization / platform users pass through. Personal users get a
// replace-redirect so back-button doesn't bounce them straight back.
//
// `to` defaults to the user's account home (e.g. /home for personal); pass
// an explicit target when the user has a more useful destination — /pricing
// redirects to /settings, where the "Manage billing & upgrade" entry point
// lives.
export default function RedirectIfPersonal({
  to,
  children,
}: {
  to?: string;
  children: ReactNode;
}) {
  const { user } = useAuth();
  if (user?.account_type === "personal") {
    return <Navigate to={to ?? homePathForUser(user)} replace />;
  }
  return <>{children}</>;
}
