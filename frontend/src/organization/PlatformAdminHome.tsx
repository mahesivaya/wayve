import { Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import "./admin-ui.css";
import "./platformAdmin.css";

export default function PlatformAdminHome() {
  const { user } = useAuth();
  const canManageMembers = hasPermission(user, "members:manage");
  const canManageApiKeys = hasPermission(user, "api_keys:manage");
  const canReadMembers = hasPermission(user, "members:read");
  const canSeePlatformBilling =
    hasPermission(user, "billing:read") || hasPermission(user, "billing:manage");
  const canSeeDeveloper =
    hasPermission(user, "logs:read") ||
    hasPermission(user, "logs:read_limited") ||
    hasPermission(user, "api_keys:manage");
  const canSeeSupport = hasPermission(user, "members:read");
  const canSeeSecurity =
    hasPermission(user, "audit:read") || hasPermission(user, "security:manage");
  const canSeeOrganizations = canManageMembers || canManageApiKeys;
  const canSeeMembers = canReadMembers;
  const isPlatformOwner = user?.effective_role === "owner";

  const hasAnyConsole =
    canSeeOrganizations ||
    canSeeMembers ||
    canSeePlatformBilling ||
    canSeeDeveloper ||
    canSeeSupport ||
    canSeeSecurity ||
    hasPermission(user, "webhooks:manage");

  return (
    <div className="platform-admin-home u-page-shell">
      <div className="platform-admin-header u-panel u-flex-between">
        <div>
          <h1>Welcome {user?.role_label ?? "Platform member"}</h1>
          <p>{user?.email}</p>
        </div>
        {isPlatformOwner && (
          <Link to="/platform/secrets" className="u-btn-primary">
            Create secrets
          </Link>
        )}
      </div>

      {hasAnyConsole && (
        <section className="platform-admin-panel u-panel">
          <div className="platform-admin-section-header">
            <div>
              <h2>Platform consoles</h2>
              <p>Role-specific dashboards across the platform team.</p>
            </div>
          </div>
          <div className="organization-name-list platform-console-list">
            {canSeeOrganizations && (
              <article>
                <strong>Organizations</strong>
                <span>Create tenants, browse existing organizations and manage their API keys.</span>
                <Link to="/platform/organizations" className="u-btn-primary">Open →</Link>
              </article>
            )}
            {canSeeMembers && (
              <article>
                <strong>Members & roles</strong>
                <span>Provision platform team accounts and adjust their role assignments.</span>
                <Link to="/platform/members" className="u-btn-primary">Open →</Link>
              </article>
            )}
            {canSeePlatformBilling && (
              <article>
                <strong>Billing</strong>
                <span>Revenue, customer subscriptions, invoices and payroll.</span>
                <Link to="/platform/billing" className="u-btn-primary">Open →</Link>
              </article>
            )}
            {canSeeSupport && (
              <article>
                <strong>Support</strong>
                <span>Customer activity, signups and shared-inbox queue.</span>
                <Link to="/platform/support" className="u-btn-primary">Open →</Link>
              </article>
            )}
            {canSeeDeveloper && (
              <article>
                <strong>Developer</strong>
                <span>API keys, audit traffic, webhooks and integrations.</span>
                <Link to="/platform/developer" className="u-btn-primary">Open →</Link>
              </article>
            )}
            {canSeeSecurity && (
              <article>
                <strong>Security</strong>
                <span>Audit logs, outcome filters and SIEM webhook forwarding.</span>
                <Link to="/security/audit" className="u-btn-primary">Open →</Link>
              </article>
            )}
            {hasPermission(user, "webhooks:manage") && (
              <article>
                <strong>SCIM provisioning</strong>
                <span>Mint bearer tokens so Okta / Entra can provision users.</span>
                <Link to="/settings/scim" className="u-btn-primary">Open →</Link>
              </article>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
