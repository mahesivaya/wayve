import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  disconnectGithub,
  disconnectGithubApp,
  getGithubAppInstallUrl,
  getGithubAppStatus,
  getGithubConnection,
  getGithubConnectUrl,
} from "../api/github";
import { useAuth } from "../auth/useAuth";
import { BrandIcon } from "./BrandIcon";

// What the panel shows, whichever way this account connects GitHub.
type PanelStatus = {
  connected: boolean;
  login?: string;
  // Organizations only: GitHub's page for choosing the shared repositories.
  manageUrl?: string | null;
  // Organizations only: false when the server has no GitHub App set up.
  configured?: boolean;
};

const messageOf = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

// What the Hadal GitHub App may and may not do, as its GitHub permissions say.
const ORG_ACCESS: { allowed: boolean; text: string }[] = [
  { allowed: true, text: "Read code, branches and commits" },
  { allowed: true, text: "Review, comment on and merge pull requests" },
  { allowed: true, text: "Read CI runs and checks" },
  { allowed: false, text: "Push code, or change settings or secrets" },
];

function AccessList({
  items,
}: {
  items: { allowed: boolean; text: string }[];
}) {
  return (
    <ul className="github-panel-access">
      {items.map((item) => (
        <li
          key={item.text}
          className={item.allowed ? "is-allowed" : "is-denied"}
        >
          <span className="github-panel-access-mark" aria-hidden="true">
            {item.allowed ? "✓" : "✕"}
          </span>
          <span className="visually-hidden">
            {item.allowed ? "Allowed: " : "Not allowed: "}
          </span>
          {item.text}
        </li>
      ))}
    </ul>
  );
}

/**
 * GitHub on the Integrations page. Personal and platform accounts connect their
 * own GitHub (OAuth), which returns to the Code Repo page. An organization
 * connects once for everyone by installing the Hadal GitHub App, which only its
 * owner can do; that returns to Settings → Repositories, where the shared
 * repositories are imported.
 */
export default function GitHubPanel({
  onChange,
}: {
  onChange?: (connected: boolean) => void;
}) {
  const { user } = useAuth();
  const isOrganization = user?.scope === "organization";
  const isOwner = user?.effective_role === "owner";
  const [status, setStatus] = useState<PanelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s: PanelStatus = isOrganization
        ? await getGithubAppStatus().then((app) => ({
            connected: app.connected,
            login: app.account_login,
            manageUrl: app.manage_url,
            configured: app.configured,
          }))
        : await getGithubConnection();
      setStatus(s);
      onChange?.(s.connected);
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, [onChange, isOrganization]);

  // Deferred to a microtask so the effect body doesn't synchronously setState.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const connect = async () => {
    setError("");
    setBusy(true);
    try {
      window.location.href = isOrganization
        ? await getGithubAppInstallUrl()
        : await getGithubConnectUrl();
    } catch (err) {
      setError(messageOf(err, "Could not start the GitHub connect."));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (
      isOrganization &&
      !window.confirm(
        "Disconnect GitHub for your organization? Private repositories stop opening here until you connect again. The app stays installed on GitHub until you remove it there."
      )
    ) {
      return;
    }
    setError("");
    setBusy(true);
    try {
      await (isOrganization ? disconnectGithubApp() : disconnectGithub());
      setStatus({ connected: false, configured: status?.configured });
      onChange?.(false);
    } catch (err) {
      setError(messageOf(err, "Could not disconnect."));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <p className="github-panel-loading">Checking GitHub…</p>;
  }
  const connected = status?.connected ?? false;
  // Only an organization's owner connects or disconnects it.
  const canManage = !isOrganization || isOwner;
  const appMissing = isOrganization && status?.configured === false;

  return (
    <div className="github-panel">
      <header className="github-panel-head">
        <span className="integration-tile-icon">
          <BrandIcon name="github" />
        </span>
        <div className="github-panel-head-text">
          <h3 className="github-panel-title">
            {isOrganization ? "GitHub for your organization" : "Your GitHub"}
          </h3>
          <p className="github-panel-subtitle">
            {isOrganization
              ? "One connection for the whole team, through the Hadal GitHub App"
              : "Import and browse the repositories your GitHub account can see"}
          </p>
        </div>
        <span
          className={`github-panel-badge${connected ? " is-connected" : ""}`}
        >
          <span className="github-panel-badge-dot" aria-hidden="true" />
          {connected ? "Connected" : "Not connected"}
        </span>
      </header>

      {connected && status?.login && (
        <div className="github-panel-account">
          <span className="github-panel-label">
            {isOrganization ? "GitHub account" : "Signed in as"}
          </span>
          <a
            className="github-panel-account-login"
            href={`https://github.com/${status.login}`}
            target="_blank"
            rel="noreferrer"
          >
            @{status.login}
          </a>
        </div>
      )}

      {appMissing ? (
        <p className="github-panel-note">
          Connecting GitHub isn&apos;t set up on this server yet. Ask your Hadal
          administrator to register the Hadal GitHub App.
        </p>
      ) : isOrganization ? (
        <>
          {!connected && (
            <section className="github-panel-section">
              <h4 className="github-panel-label">How it works</h4>
              <ol className="github-panel-steps">
                <li>Install the Hadal GitHub App on your GitHub account.</li>
                <li>
                  Choose which repositories to share. Private ones included.
                </li>
                <li>
                  Import them into projects from{" "}
                  <Link to="/settings/repositories">
                    Settings → Repositories
                  </Link>
                  .
                </li>
              </ol>
            </section>
          )}
          <section className="github-panel-section">
            <h4 className="github-panel-label">
              Access, only to the repositories you choose
            </h4>
            <AccessList items={ORG_ACCESS} />
          </section>
          {!canManage && (
            <p className="github-panel-note">
              {connected
                ? "Your organization's owner manages this connection."
                : "Only your organization's owner can connect GitHub. Ask them to set it up."}
            </p>
          )}
        </>
      ) : (
        <section className="github-panel-section">
          <h4 className="github-panel-label">Access</h4>
          <AccessList
            items={[
              {
                allowed: true,
                text: "Read the repositories your account can see",
              },
              {
                allowed: true,
                text: "Review, comment on and merge pull requests as you",
              },
            ]}
          />
        </section>
      )}

      {error && (
        <p className="integrations-error" role="alert">
          {error}
        </p>
      )}

      {canManage && !appMissing && (
        <footer className="github-panel-foot">
          {connected ? (
            <>
              <button
                type="button"
                className="github-panel-btn github-panel-btn--danger"
                onClick={() => void disconnect()}
                disabled={busy}
              >
                Disconnect
              </button>
              <span className="github-panel-foot-spacer" />
              {status?.manageUrl && (
                <a
                  className="github-panel-btn github-panel-btn--secondary"
                  href={status.manageUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Choose repositories
                </a>
              )}
              <Link
                className="github-panel-btn github-panel-btn--primary"
                to={isOrganization ? "/settings/repositories" : "/github"}
              >
                {isOrganization ? "Import repositories" : "Open Code Repo"}
              </Link>
            </>
          ) : (
            <>
              <span className="github-panel-foot-note">
                {isOrganization
                  ? "You'll be taken to GitHub to install the app."
                  : "You'll be taken to GitHub to sign in."}
              </span>
              <span className="github-panel-foot-spacer" />
              <button
                type="button"
                className="github-panel-btn github-panel-btn--primary"
                onClick={() => void connect()}
                disabled={busy}
              >
                {busy ? "Connecting…" : "Connect GitHub"}
              </button>
            </>
          )}
        </footer>
      )}
    </div>
  );
}
