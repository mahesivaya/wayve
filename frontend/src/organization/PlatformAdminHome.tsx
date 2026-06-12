import { useNavigate } from "react-router-dom";
import { useEffect, useState, type KeyboardEvent } from "react";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { adminListTickets, type SupportTicket } from "../api/support";
import { fmtListTimestamp } from "../utils/datetime";
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
    hasPermission(user, "billing:read") ||
    hasPermission(user, "billing:manage");
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
  // Reporting issues lands in support_tickets; only ticket managers (owner,
  // support, …) can pull the platform-wide admin list, so gate the inbox on
  // that permission rather than the looser members:read used for the card.
  const canManageTickets = hasPermission(user, "tickets:manage");

  // Support-tickets inbox — every ticket submitted via the Report-an-issue
  // form, surfaced right on the owner's home so they're seen at login instead
  // of buried behind the Support card. The badge counts only the still-open
  // ones (the ones needing attention); the list shows all statuses.
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);

  useEffect(() => {
    if (!canManageTickets) return;
    let cancelled = false;
    setTicketsLoading(true);
    adminListTickets()
      .then((rows) => {
        if (!cancelled) setTickets(rows);
      })
      .catch(() => {
        if (!cancelled) setTickets([]);
      })
      .finally(() => {
        if (!cancelled) setTicketsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canManageTickets]);

  const openCount = tickets.filter((t) => t.status === "open").length;

  const consoles: ConsoleCard[] = [
    {
      key: "users",
      label: "Users",
      description:
        "Browse the total number of users registered on the platform.",
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
      description:
        "Users, tenants, signups and connected mailboxes at a glance.",
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
    consoles.filter((c) => c.visible).map((c) => [c.key, c])
  );
  const ROW_KEYS: string[][] = [
    ["users", "business", "enterprise"],
    ["billing", "plans"],
    ["members", "support", "developer"],
  ];
  const namedKeys = new Set(ROW_KEYS.flat());

  const rows: ConsoleCard[][] = ROW_KEYS.map((keys) =>
    keys.map((k) => byKey.get(k)).filter((c): c is ConsoleCard => Boolean(c))
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
    path: string
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      navigate(path);
    }
  };

  const MAX_VISIBLE_TICKETS = 8;
  const visibleTickets = tickets.slice(0, MAX_VISIBLE_TICKETS);

  return (
    <div className="platform-admin-home u-page-shell">
      {canManageTickets && (
        <section className="platform-admin-panel u-panel platform-issues-panel">
          <div className="platform-issues-head">
            <h2>
              Support tickets
              {openCount > 0 && (
                <span className="platform-issues-badge">{openCount} open</span>
              )}
            </h2>
            <button
              type="button"
              className="platform-issues-all"
              onClick={() => navigate("/platform/support")}
            >
              View all
            </button>
          </div>

          {ticketsLoading ? (
            <p className="platform-issues-empty">Loading…</p>
          ) : tickets.length === 0 ? (
            <p className="platform-issues-empty">No support tickets yet.</p>
          ) : (
            <ul className="platform-issues-list">
              {visibleTickets.map((ticket) => (
                <li
                  key={ticket.id}
                  className="platform-issue-row"
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ticket: ${ticket.subject}`}
                  onClick={() => navigate("/platform/support")}
                  onKeyDown={(event) =>
                    handleCardKeyDown(event, "/platform/support")
                  }
                >
                  <span className="platform-issue-cat">{ticket.category}</span>
                  <span className="platform-issue-main">
                    <strong className="platform-issue-subject">
                      {ticket.subject}
                    </strong>
                    <span className="platform-issue-meta">
                      {ticket.user_email ?? `user #${ticket.user_id}`}
                      {ticket.organization_name
                        ? ` · ${ticket.organization_name}`
                        : ""}
                    </span>
                  </span>
                  <span
                    className={`platform-issue-status platform-issue-status--${ticket.status}`}
                  >
                    {ticket.status.replace("_", " ")}
                  </span>
                  <span className="platform-issue-time">
                    {fmtListTimestamp(ticket.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {hasAnyConsole && (
        <section className="platform-admin-panel u-panel">
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
