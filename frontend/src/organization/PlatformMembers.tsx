import MembersRolesPanel from "./MembersRolesPanel";
import "./admin-ui.css";
import "./platformAdmin.css";

export default function PlatformMembers() {
  return (
    <div className="platform-admin-home u-page-shell">
      <MembersRolesPanel scope="platform" />
    </div>
  );
}
