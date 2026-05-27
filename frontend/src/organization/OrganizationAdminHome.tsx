import { useNavigate } from "react-router-dom";
import type { KeyboardEvent } from "react";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
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
      path: "/security/audit",
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

  const apps: Tile[] = [
    {
      icon: "📬",
      label: "Email",
      description: "Manage organization communication from the shared workspace.",
      path: "/emails",
      visible: true,
    },
    {
      icon: "💬",
      label: "Team Chat",
      description: "Create channels, manage members, and coordinate team work.",
      path: "/chat",
      visible: true,
    },
    {
      icon: "✅",
      label: "Tasks",
      description: "Create and track action items for organization workflows.",
      path: "/tasks",
      visible: true,
    },
    {
      icon: "📅",
      label: "Scheduler",
      description: "Review meetings and plan team schedules.",
      path: "/scheduler",
      visible: true,
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
      <div className="organization-admin-header u-panel u-flex-between">
        <div>
          <h1>Welcome {user?.role_label ?? "Organization member"}</h1>
          <p>{user?.email}</p>
        </div>
      </div>

      <section className="organization-admin-panel u-panel">
        <div className="organization-admin-section-header">
          <div>
            <h2>Workspace</h2>
            <p>Day-to-day apps for the whole organization.</p>
          </div>
        </div>
        <div className="org-home-tiles">
          {apps.map(renderTile)}
        </div>
      </section>

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
