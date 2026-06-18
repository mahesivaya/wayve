import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { KeyboardEvent, ReactNode } from "react";
import { useAuth } from "../auth/useAuth";
import {
  MembersIcon,
  BillingIcon,
  DeveloperTileIcon,
  SecurityTileIcon,
  SupportTileIcon,
  SsoIcon,
  WebhooksIcon,
  ScimIcon,
  ProjectsTileIcon,
} from "../icons";
import { hasPermission } from "../auth/permissions";
import { getOrgKeys } from "../orgKeys/api";
import { listOrganizationMembers } from "../api/rbac";
import { getOrganizationBilling } from "../api/billing";
import { listApiKeys } from "../api/apiKeys";
import { listAuditLogs } from "../api/audit";
import { listSharedInboxes } from "../api/sharedInboxes";
import { getSsoConfig } from "../api/sso";
import { listWebhooks } from "../api/webhooks";
import { listScimTokens } from "../api/scim";
import { listGithubRepos } from "../api/github";
import "../home/home.css";
import "./admin-ui.css";
import "./organizationAdmin.css";

type TileStat = { value: string; label: string };

// Friendly names for plan codes; falls back to the raw code, or "Free" when
// the org has no plan code (the free default from effective_entitlements).
const PLAN_NAMES: Record<string, string> = {
  basic: "Basic",
  basic_user: "Basic",
  advance: "Advance",
  "most-advance": "Most Advance",
  startups: "Startups",
  business: "Business",
  enterprise: "Enterprise",
};
const prettyPlan = (code: string | null | undefined) =>
  code ? (PLAN_NAMES[code] ?? code) : "Free";

// Single tile spec — used for both the role-specific consoles row and the
// app tiles row. `visible` is computed per-user from the RBAC permission
// catalog so admins, billing, security, developer, support members each
// see only the consoles their role can act on. App tiles are visible to
// everyone (gated only by login).
type Tile = {
  icon: ReactNode;
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

  const canSeeMembers =
    hasPermission(user, "members:read") ||
    hasPermission(user, "members:manage");
  const canSeeBilling =
    hasPermission(user, "billing:read") ||
    hasPermission(user, "billing:manage");
  const canSeeDeveloper = hasPermission(user, "api_keys:manage");
  const canSeeSecurity =
    hasPermission(user, "audit:read") || hasPermission(user, "security:manage");
  const canSeeScim = hasPermission(user, "webhooks:manage");
  const canSeeWebhooks = hasPermission(user, "webhooks:manage");
  const canSeeSharedInboxes = hasPermission(user, "inbox:manage");
  const canSeeSso = hasPermission(user, "sso:manage");
  const canReadAudit = hasPermission(user, "audit:read");

  // Live figures for the org-owner console tiles.
  const [membersCount, setMembersCount] = useState<number | null>(null);
  const [planLabel, setPlanLabel] = useState<TileStat[] | null>(null);
  const [apiKeysCount, setApiKeysCount] = useState<number | null>(null);
  const [auditCount, setAuditCount] = useState<number | null>(null);
  const [inboxCount, setInboxCount] = useState<number | null>(null);
  const [ssoStat, setSsoStat] = useState<TileStat[] | null>(null);
  const [webhooksCount, setWebhooksCount] = useState<number | null>(null);
  const [scimCount, setScimCount] = useState<number | null>(null);
  const [projectsCount, setProjectsCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    listGithubRepos()
      .then((rows) => !cancelled && setProjectsCount(rows.length))
      .catch(() => !cancelled && setProjectsCount(null));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!canSeeMembers || !orgId) return;
    let cancelled = false;
    listOrganizationMembers(orgId)
      .then((m) => !cancelled && setMembersCount(m.length))
      .catch(() => !cancelled && setMembersCount(null));
    return () => {
      cancelled = true;
    };
  }, [canSeeMembers, orgId]);

  useEffect(() => {
    if (!canSeeBilling) return;
    let cancelled = false;
    getOrganizationBilling()
      .then((b) => {
        if (cancelled) return;
        setPlanLabel([
          { value: prettyPlan(b.plan_code), label: "Current plan" },
          {
            value:
              b.subscription?.status ?? (b.plan_active ? "active" : "free"),
            label: "Status",
          },
          {
            value: `${b.seats_used}/${b.seat_limit}`,
            label: "Seats",
          },
        ]);
      })
      .catch(() => !cancelled && setPlanLabel(null));
    return () => {
      cancelled = true;
    };
  }, [canSeeBilling]);

  useEffect(() => {
    if (!canSeeDeveloper) return;
    let cancelled = false;
    listApiKeys()
      .then((k) => !cancelled && setApiKeysCount(k.length))
      .catch(() => !cancelled && setApiKeysCount(null));
    return () => {
      cancelled = true;
    };
  }, [canSeeDeveloper]);

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
    if (!canSeeSharedInboxes) return;
    let cancelled = false;
    listSharedInboxes()
      .then((i) => !cancelled && setInboxCount(i.length))
      .catch(() => !cancelled && setInboxCount(null));
    return () => {
      cancelled = true;
    };
  }, [canSeeSharedInboxes]);

  useEffect(() => {
    if (!canSeeSso || !orgId) return;
    let cancelled = false;
    getSsoConfig(orgId)
      .then((cfg) => {
        if (cancelled) return;
        setSsoStat([{ value: cfg ? "Configured" : "Not set", label: "SSO" }]);
      })
      .catch(() => !cancelled && setSsoStat(null));
    return () => {
      cancelled = true;
    };
  }, [canSeeSso, orgId]);

  useEffect(() => {
    if (!canSeeWebhooks) return;
    let cancelled = false;
    listWebhooks()
      .then((w) => !cancelled && setWebhooksCount(w.length))
      .catch(() => !cancelled && setWebhooksCount(null));
    return () => {
      cancelled = true;
    };
  }, [canSeeWebhooks]);

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

  const statsForTile = (label: string): TileStat[] | null => {
    if (label === "Members & roles" && membersCount != null)
      return [{ value: membersCount.toLocaleString(), label: "Members" }];
    if (label === "Billing") return planLabel;
    if (label === "Developer" && apiKeysCount != null)
      return [{ value: apiKeysCount.toLocaleString(), label: "API keys" }];
    if (label === "Security" && auditCount != null)
      return [
        {
          value: auditCount >= 500 ? "500+" : auditCount.toLocaleString(),
          label: "Recent events",
        },
      ];
    if (label === "Support" && inboxCount != null)
      return [{ value: inboxCount.toLocaleString(), label: "Shared inboxes" }];
    if (label === "SSO") return ssoStat;
    if (label === "Webhooks" && webhooksCount != null)
      return [{ value: webhooksCount.toLocaleString(), label: "Endpoints" }];
    if (label === "SCIM provisioning" && scimCount != null)
      return [{ value: scimCount.toLocaleString(), label: "SCIM tokens" }];
    if (label === "Projects" && projectsCount != null)
      return [{ value: projectsCount.toLocaleString(), label: "Projects" }];
    return null;
  };

  const consoles: Tile[] = [
    {
      icon: <MembersIcon size={26} />,
      label: "Members & roles",
      description:
        "Provision accounts inside your organization and adjust role assignments.",
      path: "/organization/members",
      visible: canSeeMembers,
    },
    {
      icon: <BillingIcon size={26} />,
      label: "Billing",
      description: "Subscription, plan upgrades, invoices and payment methods.",
      path: "/billing",
      visible: canSeeBilling,
    },
    {
      icon: <DeveloperTileIcon size={26} />,
      label: "Developer",
      description: "API keys, scopes and usage audit for programmatic access.",
      path: "/api-keys",
      visible: canSeeDeveloper,
    },
    {
      icon: <SecurityTileIcon size={26} />,
      label: "Security",
      description: "Audit logs, outcome filters and SIEM webhook forwarding.",
      path: "/logs/audit",
      visible: canSeeSecurity,
    },
    {
      icon: <SupportTileIcon size={26} />,
      label: "Support",
      description: "Shared inboxes and customer-support queues.",
      path: "/settings/inboxes",
      visible: canSeeSharedInboxes,
    },
    {
      icon: <SsoIcon size={26} />,
      label: "SSO",
      description: "SAML / OIDC sign-in configuration for your team.",
      path: "/settings/sso",
      visible: canSeeSso,
    },
    {
      icon: <WebhooksIcon size={26} />,
      label: "Webhooks",
      description: "Outgoing event delivery and signing-secret rotation.",
      path: "/settings/webhooks",
      visible: canSeeWebhooks,
    },
    {
      icon: <ScimIcon size={26} />,
      label: "SCIM provisioning",
      description: "Mint bearer tokens so Okta / Entra can provision users.",
      path: "/settings/scim",
      visible: canSeeScim,
    },
    {
      icon: <ProjectsTileIcon size={26} />,
      label: "Projects",
      description: "Browse projects and their linked code repositories.",
      path: "/projects",
      visible: true,
    },
  ];

  const visibleConsoles = consoles.filter((c) => c.visible);
  const hasAnyConsole = visibleConsoles.length > 0;

  const handleCardKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    path: string
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void navigate(path);
    }
  };

  const renderTile = (t: Tile) => {
    const stats = statsForTile(t.label);
    return (
      <article
        key={t.path}
        className="org-home-tile"
        role="button"
        tabIndex={0}
        aria-label={`Open ${t.label}`}
        onClick={() => navigate(t.path)}
        onKeyDown={(event) => handleCardKeyDown(event, t.path)}
      >
        <div className="org-home-tile-icon" aria-hidden="true">
          {t.icon}
        </div>
        <h3 className="org-home-tile-title">{t.label}</h3>
        {stats ? (
          <div className="org-home-tile-stats">
            {stats.map((s) => (
              <div className="org-home-tile-stat" key={s.label}>
                <span className="org-home-tile-stat-value">{s.value}</span>
                <span className="org-home-tile-stat-label">{s.label}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="org-home-tile-desc">{t.description}</p>
        )}
      </article>
    );
  };

  return (
    <div className="organization-admin-home u-page-shell">
      {hasAnyConsole && (
        <section className="organization-admin-panel u-panel">
          <div className="org-home-tiles">
            {visibleConsoles.map(renderTile)}
          </div>
        </section>
      )}
    </div>
  );
}
