import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { getGmailConnectUrl, getOutlookConnectUrl } from "../api/email";
import { getJiraConnection } from "../api/jira";
import { getSlackConnection } from "../api/slack";
import { useAuth } from "../auth/useAuth";
import SlackPanel from "./SlackPanel";
import "./integrations.css";

// Brand marks as inline SVG (no logo assets ship in the repo). Approximate but
// brand-coloured and recognisable; swap for official logos if exact marks are
// needed. Rendered on a white tile so dark marks stay visible in any theme.
function BrandIcon({ name }: { name: string }) {
  switch (name) {
    case "jira":
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path
            fill="#2684FF"
            d="M21.1 11.4 12.7 3a1 1 0 0 0-1.4 0L9.7 4.6l7 7-7 7 1.6 1.6a1 1 0 0 0 1.4 0l8.4-8.4a.85.85 0 0 0 0-1.4z"
          />
          <path
            fill="#2684FF"
            opacity="0.6"
            d="M14.6 11.4 6.2 3a1 1 0 0 0-1.4 0L3.2 4.6l7 7-7 7 1.6 1.6a1 1 0 0 0 1.4 0l8.4-8.4a.85.85 0 0 0 0-1.4z"
          />
        </svg>
      );
    case "github":
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path
            fill="#181717"
            d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0C17.3 4.3 18.3 4.6 18.3 4.6c.6 1.5.2 2.7.1 3 .8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"
          />
        </svg>
      );
    case "gmail":
      return (
        <svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true">
          <path fill="#4285F4" d="M3 19h3V11l-3-2.3V17.5A1.5 1.5 0 0 0 3 19z" />
          <path fill="#34A853" d="M18 19h3a1.5 1.5 0 0 0 1.5-1.5V8.7L18 11v8z" />
          <path fill="#FBBC05" d="M18 5.6V11l4.5-3.4V6.5A1.5 1.5 0 0 0 20.1 5L18 5.6z" />
          <path fill="#C5221F" d="M6 11V5.6l6 4.4 6-4.4V11l-6 4.4L6 11z" />
          <path fill="#EA4335" d="M1.5 6.5v1.1L6 11V5.6l-2.1-1.6A1.5 1.5 0 0 0 1.5 6.5z" />
        </svg>
      );
    case "outlook":
      return (
        <svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true">
          <path fill="#0364B8" d="M22 7.5v9a1 1 0 0 1-1 1h-9V6h9a1 1 0 0 1 1 1.5z" />
          <path fill="#fff" d="M12.6 9h8.4v1.4l-4.2 2.6-4.2-2.6V9z" opacity="0.85" />
          <rect x="1.5" y="4.5" width="11.5" height="15" rx="2.4" fill="#0F78D4" />
          <ellipse
            cx="7.25"
            cy="12"
            rx="2.7"
            ry="3.3"
            fill="none"
            stroke="#fff"
            strokeWidth="1.9"
          />
        </svg>
      );
    case "slack":
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <rect x="10" y="2.5" width="3.6" height="9" rx="1.8" fill="#36C5F0" />
          <rect x="2.5" y="10.4" width="9" height="3.6" rx="1.8" fill="#2EB67D" />
          <rect x="12.5" y="12.5" width="9" height="3.6" rx="1.8" fill="#ECB22E" />
          <rect x="10.4" y="12.5" width="3.6" height="9" rx="1.8" fill="#E01E5A" />
        </svg>
      );
    case "gitlab":
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            fill="#FC6D26"
            d="M12 21.5 5 11.6l1.7-5.3a.5.5 0 0 1 .95 0L9.5 11.6h5l1.85-5.3a.5.5 0 0 1 .95 0L19 11.6 12 21.5z"
          />
          <path fill="#E24329" d="M12 21.5 9.5 11.6h5L12 21.5z" />
        </svg>
      );
    default:
      return null;
  }
}

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
      description: "Automate your merge request workflow.",
      icon: <BrandIcon name="gitlab" />,
      status: "soon",
    },
  ];

  return (
    <div className="settings-page">
      <div className="settings-stack">
        <h1 className="settings-page-title">Integrations</h1>

        <section className="settings-card">
          <h2 className="settings-card-title">Connect a service</h2>
          <div className="integrations-cards">
            {services.map((s) => {
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
      </div>
    </div>
  );
}
