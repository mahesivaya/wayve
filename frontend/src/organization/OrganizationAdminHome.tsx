import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import AIChat from "../aichat/AIChat";
import { getOrgKeys } from "../orgKeys/api";
import "../home/home.css";
import "./admin-ui.css";
import "./organizationAdmin.css";

// Organization home: the AI assistant. The sprint chart and the console tiles
// with their stats live on the Analytics page (/organization/analytics), as
// they do for the platform.
export default function OrganizationAdminHome() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // An owner whose org has no master key yet must be sent to the mnemonic flow.
  // The bootstrap page is the only place the 24 words are ever shown, so an
  // owner who skips it can never decrypt member data.
  const canBootstrap = hasPermission(user, "org_keys:bootstrap");
  const orgId = user?.organization_id ?? null;
  useEffect(() => {
    if (!canBootstrap || !orgId) return;
    let cancelled = false;
    getOrgKeys(orgId).catch((err) => {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("404") || /not[_ ]found/i.test(message)) {
        void navigate(`/organization/recovery-key/bootstrap?org=${orgId}`, {
          replace: true,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [canBootstrap, orgId, navigate]);

  return (
    <div className="organization-admin-home u-page-shell">
      <section className="organization-admin-panel u-panel org-ai-panel">
        <div className="org-ai-chat">
          <AIChat hideHeader />
        </div>
      </section>
    </div>
  );
}
