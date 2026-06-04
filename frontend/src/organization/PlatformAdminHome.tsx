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
  key: string;
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
  const canSeeAnalytics = hasPermission(user, "members:read");
  const canSeeSecurity =
    hasPermission(user, "audit:read") || hasPermission(user, "security:manage");
  const canSeeOrganizations = canManageMembers || canManageApiKeys;
  const canSeeMembers = canReadMembers;
  const canSeeScim = hasPermission(user, "webhooks:manage");
  const canManagePlans = hasPermission(user, "billing:manage");
  const isPlatformOwner = user?.effective_role === "owner";

  const consoles: ConsoleCard[] = [
    {
      key: "users",
      label: "Users",
      description: "Browse the total number of users registered on the platform.",
      path: "/platform/users",
      visible: canSeeAnalytics,
    },
    {
      key: "business",
      label: "Business",
      description:
        "Create tenants, browse existing business organizations and manage their API keys.",
      path: "/platform/organizations",
      visible: canSeeOrganizations,
    },
    {
      key: "enterprise",
      label: "Enterprise",
      description: "Browse all enterprises provisioned on the platform.",
      path: "/platform/enterprise",
      visible: canSeeOrganizations,
    },
    {
      key: "billing",
      label: "Billing",
      description: "Revenue, customer subscriptions, invoices and payroll.",
      path: "/platform/billing",
      visible: canSeePlatformBilling,
    },
    {
      key: "plans",
      label: "Plans & pricing",
      description:
        "Create, edit and deactivate the plans shown on /pricing. Set price, storage, notes and Stripe price IDs.",
      path: "/settings/plans",
      visible: canManagePlans,
    },
    {
      key: "members",
      label: "Members & roles",
      description:
        "Provision platform team accounts and adjust their role assignments.",
      path: "/platform/members",
      visible: canSeeMembers,
    },
    {
      key: "support",
      label: "Support",
      description: "In-app tickets and shared-inbox queue.",
      path: "/platform/support",
      visible: canSeeSupport,
    },
    {
      key: "developer",
      label: "Developer",
      description: "API keys, audit traffic, webhooks and integrations.",
      path: "/platform/developer",
      visible: canSeeDeveloper,
    },
    {
      key: "analytics",
      label: "Analytics",
      description: "Users, tenants, signups and connected mailboxes at a glance.",
      path: "/platform/analytics",
      visible: canSeeAnalytics,
    },
    {
      key: "security",
      label: "Security",
      description: "Audit logs, outcome filters and SIEM webhook forwarding.",
      path: "/logs/audit",
      visible: canSeeSecurity,
    },
    {
      key: "scim",
      label: "SCIM provisioning",
      description: "Mint bearer tokens so Okta / Entra can provision users.",
      path: "/settings/scim",
      visible: canSeeScim,
    },
  ];

  // Explicit dashboard layout, one inner array per row:
  //   1. Users · Business · Enterprise
  //   2. Billing · Plans & pricing
  //   3. Members · Support · Developer
  // Anything not named here (Analytics, Security, SCIM, …) flows into
  // trailing rows of up to three. Hidden (no-permission) cards drop out
  // and empty rows are skipped, so non-owner roles still get a tidy grid.
  const byKey = new Map(
    consoles.filter((c) => c.visible).map((c) => [c.key, c]),
  );
  const ROW_KEYS: string[][] = [
    ["users", "business", "enterprise"],
    ["billing", "plans"],
    ["members", "support", "developer"],
  ];
  const namedKeys = new Set(ROW_KEYS.flat());

  const rows: ConsoleCard[][] = ROW_KEYS.map((keys) =>
    keys.map((k) => byKey.get(k)).filter((c): c is ConsoleCard => Boolean(c)),
  ).filter((row) => row.length > 0);

  const remaining = consoles.filter((c) => c.visible && !namedKeys.has(c.key));
  for (let i = 0; i < remaining.length; i += 3) {
    rows.push(remaining.slice(i, i + 3));
  }

  const hasAnyConsole = rows.length > 0;

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
          <div className="platform-console-rows">
            {rows.map((row, rowIdx) => (
              <div
                key={rowIdx}
                className={`organization-name-list platform-console-list platform-console-row platform-console-row--${row.length}`}
              >
                {row.map((c) => (
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
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
