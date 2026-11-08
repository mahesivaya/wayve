import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import UserStoriesSummaryCard from "./UserStoriesSummaryCard";
import OrganizationConsoleCards from "./OrganizationConsoleCards";
import "../platformTeam/platformTeam.css";
import "./admin-ui.css";
import "./organizationAdmin.css";

/**
 * The organization's Analytics page: the User Stories sprint chart and the
 * console tiles with their stats, both moved here from the organization home,
 * which keeps only the AI chat. Open to every organization member, as the home
 * was. Each tile shows only to members with its permission, and the APIs
 * behind the chart and tiles apply their own access checks.
 */
export default function OrganizationAnalytics() {
  const { user } = useAuth();

  if (user?.scope !== "organization") return <Navigate to="/" replace />;

  return (
    <div className="pt-page">
      <header className="pt-header">
        <h1>Analytics</h1>
        <p>Sprint progress and consoles for your organization · {user.email}</p>
      </header>

      <div className="organization-admin-home org-analytics">
        <section className="organization-admin-panel u-panel">
          <UserStoriesSummaryCard />
        </section>
        <OrganizationConsoleCards />
      </div>
    </div>
  );
}
