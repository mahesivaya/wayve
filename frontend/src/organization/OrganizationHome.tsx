import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { homePathForUser } from "../auth/accountHome";

// Legacy per-organization route. The app now has one organization dashboard
// for every organization role; keep this redirect so old links still work.
export default function OrganizationHome() {
  const { user } = useAuth();
  return <Navigate to={homePathForUser(user)} replace />;
}
