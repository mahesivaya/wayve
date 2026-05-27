import { Link, useNavigate } from "react-router-dom";
import type { KeyboardEvent } from "react";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import "./admin-ui.css";
import "./platformAdmin.css";

// Single console-card spec. `visible` is computed per-user from the RBAC
// permission catalog; cards the user can't see are filtered out before
// render, so the grid only ever holds entries the user can actually open.
type ConsoleCard = {
  label: string;
  description: string;
  path: string;
  visible: boolean;
};

export default function PlatformAdminHome() {
  const navigate = useNavigate();
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
  const canSeeScim = hasPermission(user, "webhooks:manage");
  const isPlatformOwner = user?.effective_role === "owner";

  const consoles: ConsoleCard[] = [
    {
      label: "Organizations",
      description:
        "Create tenants, browse existing organizations and manage their API keys.",
      path: "/platform/organizations",
      visible: canSeeOrganizations,
    },
    {
      label: "Members & roles",
      description:
        "Provision platform team accounts and adjust their role assignments.",
      path: "/platform/members",
      visible: canSeeMembers,
    },
    {
      label: "Billing",
      description: "Revenue, customer subscriptions, invoices and payroll.",
      path: "/platform/billing",
      visible: canSeePlatformBilling,
    },
    {
      label: "Support",
      description: "Customer activity, signups and shared-inbox queue.",
      path: "/platform/support",
      visible: canSeeSupport,
    },
    {
      label: "Developer",
      description: "API keys, audit traffic, webhooks and integrations.",
      path: "/platform/developer",
      visible: canSeeDeveloper,
    },
    {
      label: "Security",
      description: "Audit logs, outcome filters and SIEM webhook forwarding.",
      path: "/security/audit",
      visible: canSeeSecurity,
    },
    {
      label: "SCIM provisioning",
      description: "Mint bearer tokens so Okta / Entra can provision users.",
      path: "/settings/scim",
      visible: canSeeScim,
    },
  ];

  const visibleConsoles = consoles.filter((c) => c.visible);
  const hasAnyConsole = visibleConsoles.length > 0;

  // Enter / Space keyboard activation so the article behaves like a
  // button for screen-reader + keyboard users. `event.preventDefault`
  // on Space stops the page from scrolling.
  const handleCardKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    path: string,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      navigate(path);
    }
  };

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
            {visibleConsoles.map((c) => (
              <article
                key={c.path}
                className="u-card-interactive"
                role="button"
                tabIndex={0}
                aria-label={`Open ${c.label}`}
                onClick={() => navigate(c.path)}
                onKeyDown={(event) => handleCardKeyDown(event, c.path)}
              >
                <strong>{c.label}</strong>
                <span>{c.description}</span>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
