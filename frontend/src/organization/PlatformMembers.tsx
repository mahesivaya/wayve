import { Link } from "react-router-dom";
import MembersRolesPanel from "./MembersRolesPanel";
import "./admin-ui.css";
import "./platformAdmin.css";

export default function PlatformMembers() {
  return (
    <div className="platform-admin-home u-page-shell">
      <div className="platform-admin-header u-panel u-flex-between">
        <div>
          <h1>Members & roles</h1>
          <p>Manage platform team members and their role assignments.</p>
        </div>
        <Link to="/platform/home" className="u-btn-primary">
          ← Back to platform home
        </Link>
      </div>

      <MembersRolesPanel scope="platform" />
    </div>
  );
}
