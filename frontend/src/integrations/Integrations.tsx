import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useSearchParams } from "react-router-dom";
import { getJiraConnection } from "../api/jira";
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
import SettingsShell from "../profile/SettingsShell";
import { useIntegrationConnections } from "./useIntegrationConnections";
import "./integrations.css";

// Bring a service's open panel into view.
function scrollToPanel(key: IntegrationKey) {
  document
    .getElementById(`integration-panel-${key}`)
    ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

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

  // Which services are connected, shared with the settings menu. A panel that
  // connects or disconnects a service reports it through `setConnected`.
  const { connected, setConnected } = useIntegrationConnections(user);
  const {
    gmail: gmailConnected,
    jira: jiraConnected,
    github: githubConnected,
    slack: slackConnected,
    gitlab: gitlabConnected,
    figma: figmaConnected,
    mcp: mcpConnected,
  } = connected;
  const [showJira, setShowJira] = useState(false);
  const [showGithub, setShowGithub] = useState(false);
  const [showSlack, setShowSlack] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showFigma, setShowFigma] = useState(false);
  const [showGitlab, setShowGitlab] = useState(false);
  const [showGmail, setShowGmail] = useState(false);
  // The panel just opened, scrolled into view once it renders: panels sit below
  // the tiles and the MCP card, so on most screens one would open out of sight
  // and the click would look like it did nothing. `n` repeats a reopen.
  const [opened, setOpened] = useState<{
    key: IntegrationKey;
    n: number;
  } | null>(null);
  useEffect(() => {
    if (opened) scrollToPanel(opened.key);
  }, [opened]);
  const reveal = (key: IntegrationKey) =>
    setOpened((prev) => ({ key, n: (prev?.n ?? 0) + 1 }));
  // A tile toggles its panel, and brings it into view when opening it.
  const toggle =
    (
      key: IntegrationKey,
      shown: boolean,
      set: Dispatch<SetStateAction<boolean>>
    ) =>
    () => {
      set(!shown);
      if (!shown) reveal(key);
    };

  // A link to /integrations?service=<key> lands with that panel already open
  // instead of on a wall of tiles. Panels are independent toggles, so this only ever opens one
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
    const opener = requestedService
      ? openers[requestedService as IntegrationKey]
      : undefined;
    if (!opener) return;
    opener();
    // Once the panel has rendered.
    const timer = window.setTimeout(
      () => scrollToPanel(requestedService as IntegrationKey),
      0
    );
    return () => window.clearTimeout(timer);
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
      onClick: toggle("gmail", showGmail, setShowGmail),
    },
    jira: {
      description:
        "Sync Jira issues into Tasks and get real-time updates from Jira via webhook.",
      status: jiraConnected ? "enabled" : "available",
      onClick: toggle("jira", showJira, setShowJira),
    },
    github: {
      description:
        "Browse repositories, commits, diffs, and CI runs from your linked projects.",
      status: githubConnected ? "enabled" : "available",
      onClick: toggle("github", showGithub, setShowGithub),
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
      onClick: isEnterprise
        ? toggle("slack", showSlack, setShowSlack)
        : undefined,
    },
    gitlab: {
      description:
        "Connect GitLab (cloud or self-hosted) and import your assigned issues into Tasks.",
      status: gitlabConnected ? "enabled" : "available",
      onClick: toggle("gitlab", showGitlab, setShowGitlab),
    },
    figma: {
      description:
        "Attach designs to tickets and user stories \u2014 paste a Figma link and it shows as a titled, thumbnailed reference.",
      status: figmaConnected ? "enabled" : "available",
      onClick: toggle("figma", showFigma, setShowFigma),
    },
    mcp: {
      description:
        "Connect your own MCP server so the AI can read your systems (e.g. your database) through tools you control.",
      status: mcpConnected ? "enabled" : "available",
      onClick: toggle("mcp", showMcp, setShowMcp),
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

  // Connected services are listed first, in their own card, with everything
  // else below. A service moves up as soon as it connects.
  const connectedServices = visibleServices.filter(
    (s) => s.status === "enabled"
  );
  const otherServices = visibleServices.filter((s) => s.status !== "enabled");
  const renderTile = (s: (typeof visibleServices)[number]) => (
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
              <span className="integration-tile-dot" aria-hidden="true" />
            )}
            {STATUS_LABEL[s.status]}
          </span>
        </span>
      </div>
      <p className="integration-tile-desc">{s.description}</p>
    </button>
  );

  return (
    <SettingsShell title="Integrations">
      {connectedServices.length > 0 && (
        <section className="settings-card">
          <h2 className="settings-card-title">Connected</h2>
          <div className="integrations-cards">
            {connectedServices.map(renderTile)}
          </div>
        </section>
      )}

      {otherServices.length > 0 && (
        <section className="settings-card">
          <h2 className="settings-card-title">Connect a service</h2>
          <div className="integrations-cards">
            {otherServices.map(renderTile)}
          </div>
        </section>
      )}

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
              onClick={() => {
                setShowMcp(true);
                reveal("mcp");
              }}
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
        <section className="settings-card" id="integration-panel-gmail">
          <h2 className="settings-card-title">Gmail</h2>
          <GmailPanel onChange={(value) => setConnected("gmail", value)} />
        </section>
      )}

      {showJira && (
        <section className="settings-card" id="integration-panel-jira">
          <h2 className="settings-card-title">Jira</h2>
          <JiraPanel
            onImported={() =>
              void getJiraConnection()
                .then((s) => setConnected("jira", s.connected))
                .catch(() => {})
            }
          />
        </section>
      )}

      {showGithub && (
        <section className="settings-card" id="integration-panel-github">
          <h2 className="settings-card-title">GitHub</h2>
          <GitHubPanel onChange={(value) => setConnected("github", value)} />
        </section>
      )}

      {isEnterprise && showSlack && (
        <section className="settings-card" id="integration-panel-slack">
          <h2 className="settings-card-title">Slack</h2>
          <SlackPanel />
        </section>
      )}

      {showFigma && (
        <section className="settings-card" id="integration-panel-figma">
          <h2 className="settings-card-title">Figma</h2>
          <FigmaPanel />
        </section>
      )}

      {canManageMcp && showMcp && (
        <section className="settings-card" id="integration-panel-mcp">
          <h2 className="settings-card-title">Connect MCP</h2>
          <McpPanel />
        </section>
      )}

      {showGitlab && (
        <section className="settings-card" id="integration-panel-gitlab">
          <h2 className="settings-card-title">GitLab</h2>
          <GitLabPanel />
        </section>
      )}
    </SettingsShell>
  );
}
