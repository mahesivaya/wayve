import { useEffect, useState, type ReactNode } from "react";
import { getJiraConnection } from "../api/jira";
import { getGithubConnection } from "../api/github";
import { getGitlabConnection } from "../api/gitlab";
import { getSlackConnection } from "../api/slack";
import { getMcpConnections } from "../api/mcp";
import { getAccounts } from "../api/email";
import { type EmailAccount } from "../emails/types";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import SlackPanel from "./SlackPanel";
import McpPanel from "./McpPanel";
import GitLabPanel from "./GitLabPanel";
import JiraPanel from "../tasks/JiraPanel";
import GitHubPanel from "./GitHubPanel";
import GmailPanel from "./GmailPanel";
import { BrandIcon } from "./BrandIcon";
import "./integrations.css";

type Status = "enabled" | "available" | "soon" | "enterprise";

const STATUS_LABEL: Record<Status, string> = {
  enabled: "Enabled",
  available: "Connect",
  soon: "Coming soon",
  enterprise: "Enterprise",
};

export default function Integrations() {
  const { user } = useAuth();
  // Slack is an enterprise-only feature (it needs server-readable chat).
  const isEnterprise = user?.current_plan?.tier === "enterprise";
  // UI visibility only; the backend enforces the same tier/scope gate.
  const canManageMcp =
    hasPermission(user, "mcp:manage") &&
    (isEnterprise || user?.scope === "platform");

  // Mirrors the backend gate `require_external_mailbox_actor`: only personal
  // accounts and a primary owner may connect their own mailbox. Everyone else
  // uses shared inboxes, so the Gmail tile is hidden rather than 403-ing.
  const isPersonalScope = user?.scope
    ? user.scope === "personal"
    : user?.account_type === "personal";
  const canConnectMailbox = isPersonalScope || user?.is_primary_owner === true;

  // Connection badges are best-effort: any error just leaves the card unconnected.
  const [jiraConnected, setJiraConnected] = useState(false);
  const [showJira, setShowJira] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getJiraConnection()
      .then((s) => {
        if (!cancelled) setJiraConnected(s.connected);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const [githubConnected, setGithubConnected] = useState(false);
  const [showGithub, setShowGithub] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getGithubConnection()
      .then((s) => {
        if (!cancelled) setGithubConnected(s.connected);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Probed only for enterprise orgs; anyone else would get a 403.
  const [slackConnected, setSlackConnected] = useState(false);
  const [showSlack, setShowSlack] = useState(false);
  useEffect(() => {
    if (!isEnterprise) return;
    let cancelled = false;
    void getSlackConnection()
      .then((s) => {
        if (!cancelled) setSlackConnected(s.connected);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isEnterprise]);

  // Probed only for enterprise/platform owners; anyone else would get a 403.
  const [mcpConnected, setMcpConnected] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  useEffect(() => {
    if (!canManageMcp) return;
    let cancelled = false;
    void getMcpConnections()
      .then((list) => {
        if (!cancelled) setMcpConnected(list.some((c) => c.enabled));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [canManageMcp]);

  const [gitlabConnected, setGitlabConnected] = useState(false);
  const [showGitlab, setShowGitlab] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getGitlabConnection()
      .then((s) => {
        if (!cancelled) setGitlabConnected(s.connected);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // The accounts summary doesn't expose the provider, so "connected" here just
  // means the user owns at least one mailbox.
  const [gmailConnected, setGmailConnected] = useState(false);
  const [showGmail, setShowGmail] = useState(false);
  useEffect(() => {
    if (!canConnectMailbox) return;
    let cancelled = false;
    void getAccounts<EmailAccount>()
      .then((list) => {
        if (!cancelled)
          setGmailConnected(list.some((a) => a.is_owner !== false));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [canConnectMailbox]);

  const services: {
    key: string;
    name: string;
    description: string;
    icon: ReactNode;
    status: Status;
    onClick?: () => void;
  }[] = [
    {
      key: "gmail",
      name: "Gmail",
      description:
        "Connect your Gmail with OAuth to read, send, and manage all your email from the Fluxze inbox.",
      icon: <BrandIcon name="gmail" />,
      status: gmailConnected ? "enabled" : "available",
      onClick: () => setShowGmail((v) => !v),
    },
    {
      key: "jira",
      name: "Jira",
      description:
        "Sync Jira issues into Tasks and get real-time updates from Jira via webhook.",
      icon: <BrandIcon name="jira" />,
      status: jiraConnected ? "enabled" : "available",
      onClick: () => setShowJira((v) => !v),
    },
    {
      key: "github",
      name: "GitHub",
      description:
        "Browse repositories, commits, diffs, and CI runs from your linked projects.",
      icon: <BrandIcon name="github" />,
      status: githubConnected ? "enabled" : "available",
      onClick: () => setShowGithub((v) => !v),
    },
    {
      key: "slack",
      name: "Slack",
      description: isEnterprise
        ? "Bridge Slack channels into Wayve Chat — import history and post replies back to Slack."
        : "Bridge Slack into Wayve Chat. Available on the Enterprise plan.",
      icon: <BrandIcon name="slack" />,
      status: isEnterprise
        ? slackConnected
          ? "enabled"
          : "available"
        : "enterprise",
      onClick: isEnterprise ? () => setShowSlack((v) => !v) : undefined,
    },
    {
      key: "gitlab",
      name: "GitLab",
      description:
        "Connect GitLab (cloud or self-hosted) and import your assigned issues into Tasks.",
      icon: <BrandIcon name="gitlab" />,
      status: gitlabConnected ? "enabled" : "available",
      onClick: () => setShowGitlab((v) => !v),
    },
    {
      key: "mcp",
      name: "Connect MCP",
      description:
        "Connect your own MCP server so the AI can read your systems (e.g. your database) through tools you control.",
      icon: <span aria-hidden="true">🔌</span>,
      status: mcpConnected ? "enabled" : "available",
      onClick: () => setShowMcp((v) => !v),
    },
  ];

  // Tiles an account can't use are hidden entirely rather than shown disabled.
  const visibleServices = services.filter(
    (s) =>
      (s.key !== "slack" || isEnterprise) &&
      (s.key !== "mcp" || canManageMcp) &&
      (s.key !== "gmail" || canConnectMailbox)
  );

  return (
    <div className="settings-page">
      <div className="settings-stack">
        <h1 className="settings-page-title">Integrations</h1>

        <section className="settings-card">
          <h2 className="settings-card-title">Connect a service</h2>
          <div className="integrations-cards">
            {visibleServices.map((s) => (
              <button
                key={s.key}
                type="button"
                className="integration-tile"
                onClick={s.onClick}
                disabled={s.status === "soon" || s.status === "enterprise"}
              >
                <div className="integration-tile-head">
                  <span className="integration-tile-icon">{s.icon}</span>
                  <span className="integration-tile-titles">
                    <span className="integration-tile-name">{s.name}</span>
                    <span
                      className={`integration-tile-status integration-tile-status--${s.status}`}
                    >
                      {STATUS_LABEL[s.status]}
                    </span>
                  </span>
                </div>
                <p className="integration-tile-desc">{s.description}</p>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-card integrations-info">
          <h2 className="settings-card-title">
            AI assistant · Model Context Protocol (MCP)
          </h2>
          <p className="integrations-info-text">
            Fluxze's AI assistant supports the{" "}
            <strong>Model Context Protocol (MCP)</strong> — an open standard for
            securely connecting AI to external tools and data. Enterprise
            organizations and platform administrators may register their own
            remote MCP servers, enabling the assistant to read live information
            from systems you operate — for example, your own database — through
            interfaces you fully control.
          </p>
          <p className="integrations-info-text">
            Fluxze never connects to your data store directly. It communicates
            only with the MCP server you designate, which governs precisely what
            the assistant may access. Connection credentials are encrypted at
            rest, and every server is validated before it is used.
          </p>
          <div className="integrations-info-foot">
            {canManageMcp ? (
              <button
                type="button"
                className="integrations-info-btn"
                onClick={() => setShowMcp(true)}
              >
                Connect an MCP server
              </button>
            ) : (
              <span className="integrations-info-badge">
                Available to Enterprise organizations and platform
                administrators
              </span>
            )}
          </div>
        </section>

        {canConnectMailbox && showGmail && (
          <section className="settings-card">
            <h2 className="settings-card-title">Gmail</h2>
            <GmailPanel onChange={setGmailConnected} />
          </section>
        )}

        {showJira && (
          <section className="settings-card">
            <h2 className="settings-card-title">Jira</h2>
            <JiraPanel
              onImported={() =>
                void getJiraConnection()
                  .then((s) => setJiraConnected(s.connected))
                  .catch(() => {})
              }
            />
          </section>
        )}

        {showGithub && (
          <section className="settings-card">
            <h2 className="settings-card-title">GitHub</h2>
            <GitHubPanel onChange={setGithubConnected} />
          </section>
        )}

        {isEnterprise && showSlack && (
          <section className="settings-card">
            <h2 className="settings-card-title">Slack</h2>
            <SlackPanel />
          </section>
        )}

        {canManageMcp && showMcp && (
          <section className="settings-card">
            <h2 className="settings-card-title">Connect MCP</h2>
            <McpPanel />
          </section>
        )}

        {showGitlab && (
          <section className="settings-card">
            <h2 className="settings-card-title">GitLab</h2>
            <GitLabPanel />
          </section>
        )}
      </div>
    </div>
  );
}
