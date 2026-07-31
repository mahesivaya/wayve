import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getJiraConnection } from "../api/jira";
import { getGithubConnection } from "../api/github";
import { getGitlabConnection } from "../api/gitlab";
import { getSlackConnection } from "../api/slack";
import { getFigmaConnection } from "../api/figma";
import { getMcpConnections } from "../api/mcp";
import { getAccounts } from "../api/email";
import { type EmailAccount } from "../emails/types";
import { useAuth } from "../auth/useAuth";
import SlackPanel from "./SlackPanel";
import FigmaPanel from "./FigmaPanel";
import McpPanel from "./McpPanel";
import GitLabPanel from "./GitLabPanel";
import JiraPanel from "../tasks/JiraPanel";
import GitHubPanel from "./GitHubPanel";
import GmailPanel from "./GmailPanel";
import {
  visibleIntegrations,
  canManageMcp as viewerCanManageMcp,
  type IntegrationKey,
} from "./catalog";
import { INTEGRATIONS_CHANGED_EVENT } from "./useConnectedIntegrations";
import SettingsShell from "../profile/SettingsShell";
import "./integrations.css";

type Status = "enabled" | "available" | "soon" | "enterprise";

// "Connected" rather than "Enabled": the question being answered at a glance is
// whether the service is actually wired up, and "Enabled" reads like a setting.
const STATUS_LABEL: Record<Status, string> = {
  enabled: "Connected",
  available: "Connect",
  soon: "Coming soon",
  enterprise: "Enterprise",
};

export default function Integrations() {
  const { user } = useAuth();
  // Slack is an enterprise-only feature (it needs server-readable chat).
  const isEnterprise = user?.current_plan?.tier === "enterprise";
  const canManageMcp = viewerCanManageMcp(user);

  // Mirrors the backend gate `require_external_mailbox_actor`: any signed-in
  // account may connect its own mailbox — the address it logged in with —
  // regardless of scope (personal, organization/enterprise, or platform).
  const canConnectMailbox = !!user;

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

  // Per-user, so every account probes it — no tier or scope gate.
  const [figmaConnected, setFigmaConnected] = useState(false);
  const [showFigma, setShowFigma] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getFigmaConnection()
      .then((s) => {
        if (!cancelled) setFigmaConnected(s.connected);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  // The sidebar lists connected services only, so tell it to re-check whenever
  // something here connects or disconnects. (The first probes fire this too;
  // it's one cached request.)
  useEffect(() => {
    window.dispatchEvent(new Event(INTEGRATIONS_CHANGED_EVENT));
  }, [
    gmailConnected,
    jiraConnected,
    githubConnected,
    slackConnected,
    gitlabConnected,
    figmaConnected,
    mcpConnected,
  ]);

  // The sidebar's Integrations group links to /integrations?service=<key>, so
  // picking a service there lands with that panel already open instead of on a
  // wall of tiles. Panels are independent toggles, so this only ever opens one
  // — closing it again (or opening others) is left to the tiles.
  const [searchParams] = useSearchParams();
  const requestedService = searchParams.get("service");
  useEffect(() => {
    const openers: Partial<Record<IntegrationKey, () => void>> = {
      gmail: () => setShowGmail(true),
      jira: () => setShowJira(true),
      github: () => setShowGithub(true),
      slack: () => setShowSlack(true),
      gitlab: () => setShowGitlab(true),
      figma: () => setShowFigma(true),
      mcp: () => setShowMcp(true),
    };
    if (requestedService) openers[requestedService as IntegrationKey]?.();
  }, [requestedService]);

  // Per-service copy and behaviour. The name, icon, order, and who may see a
  // service at all come from the shared catalog, so the sidebar's Integrations
  // group and this page always list the same services.
  const detail: Record<
    IntegrationKey,
    { description: string; status: Status; onClick?: () => void }
  > = {
    gmail: {
      description:
        "Connect your Gmail with OAuth to read, send, and manage all your email from the Fluxze inbox.",
      status: gmailConnected ? "enabled" : "available",
      onClick: () => setShowGmail((v) => !v),
    },
    jira: {
      description:
        "Sync Jira issues into Tasks and get real-time updates from Jira via webhook.",
      status: jiraConnected ? "enabled" : "available",
      onClick: () => setShowJira((v) => !v),
    },
    github: {
      description:
        "Browse repositories, commits, diffs, and CI runs from your linked projects.",
      status: githubConnected ? "enabled" : "available",
      onClick: () => setShowGithub((v) => !v),
    },
    slack: {
      description: isEnterprise
        ? "Bridge Slack channels into Wayve Chat — import history and post replies back to Slack."
        : "Bridge Slack into Wayve Chat. Available on the Enterprise plan.",
      status: isEnterprise
        ? slackConnected
          ? "enabled"
          : "available"
        : "enterprise",
      onClick: isEnterprise ? () => setShowSlack((v) => !v) : undefined,
    },
    gitlab: {
      description:
        "Connect GitLab (cloud or self-hosted) and import your assigned issues into Tasks.",
      status: gitlabConnected ? "enabled" : "available",
      onClick: () => setShowGitlab((v) => !v),
    },
    figma: {
      description:
        "Attach designs to tickets and user stories \u2014 paste a Figma link and it shows as a titled, thumbnailed reference.",
      status: figmaConnected ? "enabled" : "available",
      onClick: () => setShowFigma((v) => !v),
    },
    mcp: {
      description:
        "Connect your own MCP server so the AI can read your systems (e.g. your database) through tools you control.",
      status: mcpConnected ? "enabled" : "available",
      onClick: () => setShowMcp((v) => !v),
    },
  };

  // Services an account can't use at all are hidden rather than shown disabled
  // — the catalog's per-service `visible` rules decide.
  //
  // Slack is the exception: it stays on the list for every plan, carrying its
  // "Enterprise" badge, because hiding it answered the question "can I connect
  // Slack?" with silence. The card is inert below that tier and the backend
  // gates the endpoints regardless, so showing it advertises the feature
  // without granting it.
  const visibleServices = visibleIntegrations(user).map((s) => ({
    ...s,
    ...detail[s.key],
  }));

  return (
    <SettingsShell title="Integrations">
      <section className="settings-card">
        <h2 className="settings-card-title">Connect a service</h2>
        <div className="integrations-cards">
          {visibleServices.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`integration-tile${
                s.status === "enabled" ? " integration-tile--connected" : ""
              }`}
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
                    {/* The dot is decorative — the word "Connected" carries the
                        meaning, so the state never rests on colour alone. */}
                    {s.status === "enabled" && (
                      <span
                        className="integration-tile-dot"
                        aria-hidden="true"
                      />
                    )}
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
              Available to Enterprise organizations and platform administrators
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

      {showFigma && (
        <section className="settings-card">
          <h2 className="settings-card-title">Figma</h2>
          <FigmaPanel />
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
    </SettingsShell>
  );
}
