import { Link, useParams } from "react-router-dom";
import "./platformAdmin.css";

export default function PlatformOrganizationDetail() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="platform-admin-home u-page-shell">
      <div className="platform-admin-header u-panel u-flex-between">
        <div>
          <h1>Organization</h1>
          <p>Details for organization #{id}.</p>
        </div>
        <Link to="/platform/organizations" className="u-btn-primary">
          ← Back to organizations
        </Link>
      </div>

      <section className="platform-admin-panel u-panel">
        <div className="organization-detail-welcome">
          <h2>Welcome 👋</h2>
          <p>This is the organization page. More details coming soon.</p>
        </div>
      </section>
    </div>
  );
}
