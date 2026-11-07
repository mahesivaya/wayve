import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import UserStoriesSummaryCard from "./UserStoriesSummaryCard";
import "../platformTeam/platformTeam.css";
import "./admin-ui.css";
import "./organizationAdmin.css";

/**
 * The organization's Analytics page. Holds the User Stories sprint chart,
 * moved here from the organization home, so the home keeps only the AI chat
 * and the console tiles. Open to every organization member, as the home was;
 * the user-stories API still applies its own access checks.
 */
export default function OrganizationAnalytics() {
  const { user } = useAuth();

  if (user?.scope !== "organization") return <Navigate to="/" replace />;

  return (
    <div className="pt-page">
      <header className="pt-header">
        <h1>Analytics</h1>
        <p>Sprint progress for your organization · {user.email}</p>
      </header>

      <section className="organization-admin-panel u-panel">
        <UserStoriesSummaryCard />
      </section>
    </div>
  );
}
