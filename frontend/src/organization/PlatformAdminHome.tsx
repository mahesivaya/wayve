import { useNavigate } from "react-router-dom";
import { useEffect, useState, type KeyboardEvent } from "react";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  getSupportSummary,
  getUsersSummary,
  type SupportSummary,
  type UsersSummary,
} from "../api/platformTeam";
import { listAdminOrganizations, type AdminOrganization } from "../api/admin";
import {
  getPlatformBillingOverview,
  type PlatformBillingOverview,
} from "../api/platformBilling";
import { adminListPlans } from "../api/billing";
import { listPlatformMembers } from "../api/rbac";
import { adminListTickets } from "../api/support";
import { listApiKeys } from "../api/apiKeys";
import { listAuditLogs } from "../api/audit";
import { listScimTokens } from "../api/scim";
import { listGithubRepos } from "../api/github";
import { formatBytes } from "../utils/bytes";
import "./admin-ui.css";
import "./platformAdmin.css";

type CardStat = { value: string; label: string };

function fmtMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

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

  // Live figures for the Users card — total users + storage used + emails, so
  // the card shows real data at a glance instead of a static description.
  const [usersSummary, setUsersSummary] = useState<UsersSummary | null>(null);
  // Business + Enterprise cards aggregate the same admin-org list.
  const [orgs, setOrgs] = useState<AdminOrganization[] | null>(null);
  // Billing + Plans cards.
  const [billing, setBilling] = useState<PlatformBillingOverview | null>(null);
  const [plansCount, setPlansCount] = useState<number | null>(null);
  // Remaining cards: members, support, developer, analytics, security, scim.
  const [membersCount, setMembersCount] = useState<number | null>(null);
  const [ticketsCount, setTicketsCount] = useState<number | null>(null);
  const [apiKeysCount, setApiKeysCount] = useState<number | null>(null);
  const [summary, setSummary] = useState<SupportSummary | null>(null);
  const [auditCount, setAuditCount] = useState<number | null>(null);
  const [scimCount, setScimCount] = useState<number | null>(null);
  const [projectsCount, setProjectsCount] = useState<number | null>(null);

  const canSeeOrgStats = canManageMembers || canManageApiKeys;
  const canSeeBilling =
    hasPermission(user, "billing:read") || hasPermission(user, "billing:manage");
  const canManagePlansPerm = hasPermission(user, "billing:manage");
  const canManageTickets = hasPermission(user, "tickets:manage");
  const canReadAudit = hasPermission(user, "audit:read");

  useEffect(() => {
    if (!canReadMembers) return;
    let cancelled = false;
    getUsersSummary()
      .then((s) => {
        if (!cancelled) setUsersSummary(s);
      })
      .catch(() => {
        if (!cancelled) setUsersSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canReadMembers]);

  useEffect(() => {
    if (!canSeeOrgStats) return;
    let cancelled = false;
    listAdminOrganizations()
      .then((items) => {
        if (!cancelled) setOrgs(items);
      })
      .catch(() => {
        if (!cancelled) setOrgs(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canSeeOrgStats]);

  useEffect(() => {
    if (!canSeeBilling) return;
    let cancelled = false;
    getPlatformBillingOverview()
      .then((o) => {
        if (!cancelled) setBilling(o);
      })
      .catch(() => {
        if (!cancelled) setBilling(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canSeeBilling]);

  useEffect(() => {
    if (!canManagePlansPerm) return;
    let cancelled = false;
    adminListPlans()
      .then((plans) => {
        if (!cancelled) setPlansCount(plans.length);
      })
      .catch(() => {
        if (!cancelled) setPlansCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canManagePlansPerm]);

  useEffect(() => {
    if (!canReadMembers) return;
    let cancelled = false;
    listPlatformMembers()
      .then((m) => !cancelled && setMembersCount(m.length))
      .catch(() => !cancelled && setMembersCount(null));
    getSupportSummary()
      .then((s) => !cancelled && setSummary(s))
      .catch(() => !cancelled && setSummary(null));
    return () => {
      cancelled = true;
    };
  }, [canReadMembers]);

  useEffect(() => {
    if (!canManageTickets) return;
    let cancelled = false;
    adminListTickets()
      .then((t) => !cancelled && setTicketsCount(t.length))
      .catch(() => !cancelled && setTicketsCount(null));
    return () => {
      cancelled = true;
    };
  }, [canManageTickets]);

  useEffect(() => {
    if (!canManageApiKeys) return;
    let cancelled = false;
    listApiKeys()
      .then((k) => !cancelled && setApiKeysCount(k.length))
      .catch(() => !cancelled && setApiKeysCount(null));
    return () => {
      cancelled = true;
    };
  }, [canManageApiKeys]);

  useEffect(() => {
    if (!canReadAudit) return;
    let cancelled = false;
    listAuditLogs({ limit: 500 })
      .then((rows) => !cancelled && setAuditCount(rows.length))
      .catch(() => !cancelled && setAuditCount(null));
    return () => {
      cancelled = true;
    };
  }, [canReadAudit]);

  useEffect(() => {
    if (!canSeeScim) return;
    let cancelled = false;
    listScimTokens()
      .then((t) => !cancelled && setScimCount(t.length))
      .catch(() => !cancelled && setScimCount(null));
    return () => {
      cancelled = true;
    };
  }, [canSeeScim]);

  useEffect(() => {
    let cancelled = false;
    listGithubRepos()
      .then((rows) => !cancelled && setProjectsCount(rows.length))
      .catch(() => !cancelled && setProjectsCount(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const orgTotals = (orgs ?? []).reduce(
    (acc, o) => ({
      members: acc.members + (o.user_count ?? 0),
      storage: acc.storage + (o.storage_used_bytes ?? 0),
      emailAccounts: acc.emailAccounts + (o.email_account_count ?? 0),
    }),
    { members: 0, storage: 0, emailAccounts: 0 }
  );

  // Per-card live stats, keyed by card. Returns null when the data for that
  // card hasn't loaded (the card falls back to its description).
  const statsForCard = (key: string): CardStat[] | null => {
    if (key === "users" && usersSummary) {
      return [
        { value: usersSummary.users_total.toLocaleString(), label: "Total users" },
        {
          value: formatBytes(usersSummary.storage_used_bytes),
          label: "Memory used",
        },
        { value: usersSummary.emails_total.toLocaleString(), label: "Emails" },
        {
          value: `+${usersSummary.users_new_1m.toLocaleString()}`,
          label: "New this month",
        },
      ];
    }
    if (key === "business" && orgs) {
      return [
        { value: orgs.length.toLocaleString(), label: "Businesses" },
        { value: orgTotals.members.toLocaleString(), label: "Members" },
        { value: formatBytes(orgTotals.storage), label: "Memory used" },
        {
          value: orgTotals.emailAccounts.toLocaleString(),
          label: "Email accounts",
        },
      ];
    }
    if (key === "enterprise" && orgs) {
      return [
        { value: orgs.length.toLocaleString(), label: "Enterprises" },
        { value: formatBytes(orgTotals.storage), label: "Memory used" },
        {
          value: orgTotals.emailAccounts.toLocaleString(),
          label: "Email accounts",
        },
      ];
    }
    if (key === "billing" && billing) {
      return [
        { value: fmtMoney(billing.mrr_cents, billing.currency), label: "MRR" },
        {
          value: fmtMoney(billing.paid_invoices_30d_cents, billing.currency),
          label: "Paid (30d)",
        },
        {
          value: (
            billing.active_user_subscriptions +
            billing.active_organization_subscriptions
          ).toLocaleString(),
          label: "Active subscriptions",
        },
      ];
    }
    if (key === "plans" && plansCount != null) {
      return [{ value: plansCount.toLocaleString(), label: "Plans" }];
    }
    if (key === "members" && membersCount != null) {
      return [{ value: membersCount.toLocaleString(), label: "Members" }];
    }
    if (key === "support" && ticketsCount != null) {
      return [{ value: ticketsCount.toLocaleString(), label: "Tickets" }];
    }
    if (key === "developer" && apiKeysCount != null) {
      return [{ value: apiKeysCount.toLocaleString(), label: "API keys" }];
    }
    if (key === "analytics" && summary) {
      return [
        {
          value: summary.connected_mailboxes.toLocaleString(),
          label: "Connected mailboxes",
        },
        {
          value: `+${summary.users_new_7d.toLocaleString()}`,
          label: "New users (7d)",
        },
      ];
    }
    if (key === "security" && auditCount != null) {
      return [
        {
          value: auditCount >= 500 ? "500+" : auditCount.toLocaleString(),
          label: "Recent events",
        },
      ];
    }
    if (key === "scim" && scimCount != null) {
      return [{ value: scimCount.toLocaleString(), label: "SCIM tokens" }];
    }
    if (key === "projects" && projectsCount != null) {
      return [{ value: projectsCount.toLocaleString(), label: "Projects" }];
    }
    return null;
  };

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
    {
      key: "projects",
      label: "Projects",
      description: "Browse projects and their linked code repositories.",
      path: "/projects",
      visible: canReadMembers,
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

  return (
    <div className="platform-admin-home u-page-shell">
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
                    {(() => {
                      const stats = statsForCard(c.key);
                      return stats ? (
                        <div className="platform-card-stats">
                          {stats.map((s) => (
                            <div className="platform-card-stat" key={s.label}>
                              <span className="platform-card-stat-value">
                                {s.value}
                              </span>
                              <span className="platform-card-stat-label">
                                {s.label}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span>{c.description}</span>
                      );
                    })()}
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
