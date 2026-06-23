import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { getGmailConnectUrl, getOutlookConnectUrl } from "../api/email";
import { getJiraConnection } from "../api/jira";
import { getGitlabConnection } from "../api/gitlab";
import { getSlackConnection } from "../api/slack";
import { useAuth } from "../auth/useAuth";
import SlackPanel from "./SlackPanel";
import GitLabPanel from "./GitLabPanel";
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
  const navigate = useNavigate();
  const { user } = useAuth();
  // Slack is an enterprise-only feature (it needs server-readable chat).
  const isEnterprise = user?.current_plan?.tier === "enterprise";

  // Live Jira connection state drives the Jira card's badge (Enabled vs
  // Connect). Best-effort: any error just leaves it unconnected.
  const [jiraConnected, setJiraConnected] = useState(false);
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

  // Slack connection badge — only enterprise orgs can reach the endpoint, so we
  // only probe it for them (a non-enterprise probe would 403).
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

  // GitLab connection badge (per-user, any account).
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

  // Mailbox connect: hand off to the per-user OAuth flow (Gmail / Outlook).
  // `busyKey` marks which card is mid-redirect; errors surface below the grid.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const connectMailbox = async (key: string, getUrl: () => Promise<string>) => {
    setBusyKey(key);
    setConnectError(null);
    try {
      window.location.href = await getUrl();
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : "Could not start the connection."
      );
      setBusyKey(null);
    }
  };

  const services: {
    key: string;
    name: string;
    description: string;
    icon: ReactNode;
    status: Status;
    onClick?: () => void;
  }[] = [
    {
      key: "jira",
      name: "Jira",
      description:
        "Sync Jira issues into Tasks and get real-time updates from Jira via webhook.",
      icon: <BrandIcon name="jira" />,
      status: jiraConnected ? "enabled" : "available",
      onClick: () => void navigate("/tasks"),
    },
    {
      key: "github",
      name: "GitHub",
      description:
        "Browse repositories, commits, diffs, and CI runs from your linked projects.",
      icon: <BrandIcon name="github" />,
      status: "enabled",
      onClick: () => void navigate("/github"),
    },
    {
      key: "gmail",
      name: "Gmail",
      description:
        "Connect a Gmail mailbox to import its mail and read it under Emails.",
      icon: <BrandIcon name="gmail" />,
      status: "available",
      onClick: () => void connectMailbox("gmail", getGmailConnectUrl),
    },
    {
      key: "outlook",
      name: "Outlook",
      description:
        "Connect an Outlook mailbox to import its mail and read it under Emails.",
      icon: <BrandIcon name="outlook" />,
      status: "available",
      onClick: () => void connectMailbox("outlook", getOutlookConnectUrl),
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
  ];

  // Slack is enterprise-only — hide the tile entirely from personal and
  // business accounts rather than showing a disabled "Enterprise" badge.
  const visibleServices = services.filter(
    (s) => s.key !== "slack" || isEnterprise
  );

  return (
    <div className="settings-page">
      <div className="settings-stack">
        <h1 className="settings-page-title">Integrations</h1>

        <section className="settings-card">
          <h2 className="settings-card-title">Connect a service</h2>
          <div className="integrations-cards">
            {visibleServices.map((s) => {
              const connecting = busyKey === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  className="integration-tile"
                  onClick={s.onClick}
                  disabled={
                    s.status === "soon" ||
                    s.status === "enterprise" ||
                    connecting
                  }
                >
                  <div className="integration-tile-head">
                    <span className="integration-tile-icon">{s.icon}</span>
                    <span className="integration-tile-titles">
                      <span className="integration-tile-name">{s.name}</span>
                      <span
                        className={`integration-tile-status integration-tile-status--${s.status}`}
                      >
                        {connecting ? "Connecting…" : STATUS_LABEL[s.status]}
                      </span>
                    </span>
                  </div>
                  <p className="integration-tile-desc">{s.description}</p>
                </button>
              );
            })}
          </div>
          {connectError && <p className="integrations-error">{connectError}</p>}
        </section>

        {isEnterprise && showSlack && (
          <section className="settings-card">
            <h2 className="settings-card-title">Slack</h2>
            <SlackPanel />
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
