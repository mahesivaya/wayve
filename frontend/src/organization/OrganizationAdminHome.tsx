import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { KeyboardEvent } from "react";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { getOrgKeys } from "../orgKeys/api";
import ActivityDashboard from "../home/dashboard/ActivityDashboard";
import "../home/home.css";
import "./admin-ui.css";
import "./organizationAdmin.css";

// Single tile spec — used for both the role-specific consoles row and the
// app tiles row. `visible` is computed per-user from the RBAC permission
// catalog so admins, billing, security, developer, support members each
// see only the consoles their role can act on. App tiles are visible to
// everyone (gated only by login).
type Tile = {
  icon: string;
  label: string;
  description: string;
  path: string;
  visible: boolean;
};

export default function OrganizationAdminHome() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // If this user is the org owner (only the owner holds `org_keys:bootstrap`)
  // and the org has no master key yet — which is the state right after a
  // platform-admin-created org, or a self-serve org whose first owner closed
  // the tab during bootstrap — send them to the mnemonic flow. Without this,
  // a freshly-provisioned owner lands on the dashboard, never sees the 24
  // words, and silently can't ever decrypt member data. The bootstrap page
  // is the single place the mnemonic is shown, by design (one-time).
  const canBootstrap = hasPermission(user, "org_keys:bootstrap");
  const orgId = user?.organization_id ?? null;
  useEffect(() => {
    if (!canBootstrap || !orgId) return;
    let cancelled = false;
    getOrgKeys(orgId)
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("404") || /not[_ ]found/i.test(message)) {
          navigate(
            `/organization/recovery-key/bootstrap?org=${orgId}`,
            { replace: true },
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canBootstrap, orgId, navigate]);

  const canSeeMembers =
    hasPermission(user, "members:read") || hasPermission(user, "members:manage");
  const canSeeBilling =
    hasPermission(user, "billing:read") || hasPermission(user, "billing:manage");
  const canSeeDeveloper = hasPermission(user, "api_keys:manage");
  const canSeeSecurity =
    hasPermission(user, "audit:read") || hasPermission(user, "security:manage");
  const canSeeScim = hasPermission(user, "webhooks:manage");
  const canSeeWebhooks = hasPermission(user, "webhooks:manage");
  const canSeeSharedInboxes = hasPermission(user, "inbox:manage");
  const canSeeSso = hasPermission(user, "sso:manage");

  const consoles: Tile[] = [
    {
      icon: "👥",
      label: "Members & roles",
      description: "Provision accounts inside your organization and adjust role assignments.",
      path: "/organization/members",
      visible: canSeeMembers,
    },
    {
      icon: "💳",
      label: "Billing",
      description: "Subscription, plan upgrades, invoices and payment methods.",
      path: "/billing",
      visible: canSeeBilling,
    },
    {
      icon: "🔑",
      label: "Developer",
      description: "API keys, scopes and usage audit for programmatic access.",
      path: "/api-keys",
      visible: canSeeDeveloper,
    },
    {
      icon: "🛡️",
      label: "Security",
      description: "Audit logs, outcome filters and SIEM webhook forwarding.",
      path: "/logs/audit",
      visible: canSeeSecurity,
    },
    {
      icon: "🎧",
      label: "Support",
      description: "Shared inboxes and customer-support queues.",
      path: "/settings/inboxes",
      visible: canSeeSharedInboxes,
    },
    {
      icon: "🔐",
      label: "SSO",
      description: "SAML / OIDC sign-in configuration for your team.",
      path: "/settings/sso",
      visible: canSeeSso,
    },
    {
      icon: "📡",
      label: "Webhooks",
      description: "Outgoing event delivery and signing-secret rotation.",
      path: "/settings/webhooks",
      visible: canSeeWebhooks,
    },
    {
      icon: "🪪",
      label: "SCIM provisioning",
      description: "Mint bearer tokens so Okta / Entra can provision users.",
      path: "/settings/scim",
      visible: canSeeScim,
    },
  ];

  const visibleConsoles = consoles.filter((c) => c.visible);
  const hasAnyConsole = visibleConsoles.length > 0;

  const handleCardKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    path: string,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      navigate(path);
    }
  };

  const renderTile = (t: Tile) => (
    <article
      key={t.path}
      className="org-home-tile"
      role="button"
      tabIndex={0}
      aria-label={`Open ${t.label}`}
      onClick={() => navigate(t.path)}
      onKeyDown={(event) => handleCardKeyDown(event, t.path)}
    >
      <div className="org-home-tile-icon" aria-hidden="true">{t.icon}</div>
      <h3 className="org-home-tile-title">{t.label}</h3>
      <p className="org-home-tile-desc">{t.description}</p>
    </article>
  );

  return (
    <div className="organization-admin-home u-page-shell">
      <ActivityDashboard />

      {hasAnyConsole && (
        <section className="organization-admin-panel u-panel">
          <div className="organization-admin-section-header">
            <div>
              <h2>Organization consoles</h2>
              <p>Role-specific dashboards across your organization.</p>
            </div>
          </div>
          <div className="org-home-tiles">
            {visibleConsoles.map(renderTile)}
          </div>
        </section>
      )}
    </div>
  );
}
