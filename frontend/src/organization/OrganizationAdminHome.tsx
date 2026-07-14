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
  AIChatIcon,
} from "../icons";
import { hasPermission } from "../auth/permissions";
import { useGlobalSearch } from "../search/SearchContext";
import { matchesTileSearch } from "../search/tileSearch";
import AIChat from "../aichat/AIChat";
import { getOrgKeys } from "../orgKeys/api";
import { listOrganizationMembers } from "../api/rbac";
import { getOrganizationBilling } from "../api/billing";
import { planName } from "../billing/planCatalog";
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

// `visible` is UI gating only, never authorization: the backend re-checks every
// call. App tiles are visible to everyone.
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
  const canSeeAi = hasPermission(user, "ai:manage");

  const { searchQuery, normalizedSearchQuery, setSearchQuery } =
    useGlobalSearch();

  // The search query is app-wide state that survives navigation, so a leftover
  // query from another page would silently hide most tiles on arrival.
  useEffect(() => {
    setSearchQuery("");
  }, [setSearchQuery]);

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
          { value: planName(b.plan_code), label: "Current plan" },
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
    {
      icon: <AIChatIcon size={26} />,
      label: "AI Provider",
      description:
        "Choose the AI your team's assistant runs on, and track usage & cost.",
      path: "/settings/ai",
      visible: canSeeAi,
    },
  ];

  // RBAC and search filtering stay separate so an empty result is attributable:
  // "no consoles" and "nothing matched" get different copy below.
  const visibleConsoles = consoles.filter((c) => c.visible);
  const hasAnyConsole = visibleConsoles.length > 0;
  const matchedConsoles = visibleConsoles.filter((c) =>
    matchesTileSearch(normalizedSearchQuery, c.label, c.description)
  );
  const noSearchMatches = hasAnyConsole && matchedConsoles.length === 0;

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
      {/* AI ask-box first — this is the org member's landing surface, so the
        primary action is asking, not navigating. Same arrangement (and same
        embedded component) as the platform home. */}
      <section className="organization-admin-panel u-panel org-ai-panel">
        <div className="org-ai-chat">
          <AIChat hideHeader />
        </div>
      </section>

      {hasAnyConsole && (
        <section className="organization-admin-panel u-panel">
          {noSearchMatches ? (
            <p className="organization-admin-empty">
              Nothing here matches “{searchQuery.trim()}”.
            </p>
          ) : (
            <div className="org-home-tiles">{matchedConsoles.map(renderTile)}</div>
          )}
        </section>
      )}
    </div>
  );
}
