import { hasPermission } from "../auth/permissions";
import { useAuth } from "../auth/useAuth";
import MembersRolesPanel from "./MembersRolesPanel";
import "./admin-ui.css";
import "./platformAdmin.css";

export default function PlatformMembers() {
  const { user } = useAuth();
  // The panel draws nothing for a role that can't read members, which is right
  // where it is one part of a page. As the whole page it left a blank screen.
  if (!hasPermission(user, "members:read")) {
    return (
      <div className="platform-admin-home u-page-shell">
        <p className="platform-no-access">
          Your role doesn&apos;t have access to platform members. Ask a platform
          owner.
        </p>
      </div>
    );
  }
  return (
    <div className="platform-admin-home u-page-shell">
      <MembersRolesPanel scope="platform" />
    </div>
  );
}
