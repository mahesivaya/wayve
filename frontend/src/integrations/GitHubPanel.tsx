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

  if (loading) return null;
  const connected = status?.connected ?? false;
  // Only an organization's owner connects or disconnects it.
  const canManage = !isOrganization || isOwner;
  const appMissing = isOrganization && status?.configured === false;

  return (
    <div className="github-panel">
      <p className="github-panel-status">
        {connected ? (
          <>
            Connected as <strong>{status?.login}</strong>
          </>
        ) : (
          "Not connected"
        )}
      </p>

      {error && <p className="integrations-error">{error}</p>}

      {canManage && !appMissing && (
        <div className="github-panel-actions">
          {connected ? (
            <>
              {status?.manageUrl && (
                <a
                  className="integrations-info-btn"
                  href={status.manageUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Choose repositories
                </a>
              )}
              <button
                type="button"
                className="integrations-info-btn"
                onClick={() => void disconnect()}
                disabled={busy}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              className="integrations-info-btn"
              onClick={() => void connect()}
              disabled={busy}
            >
              {busy ? "Connecting…" : "Connect GitHub"}
            </button>
          )}
        </div>
      )}

      <p className="integrations-info-text">
        {!isOrganization ? (
          "Connecting authorizes Hadal to read your repositories. Import and browse them from the Code Repo page."
        ) : appMissing ? (
          "Connecting GitHub isn't set up on this server yet."
        ) : (
          <>
            Your organization connects GitHub once for everyone by installing
            the Hadal GitHub App and choosing which repositories to share,
            private ones included.{" "}
            {canManage
              ? "Then import them from "
              : connected
                ? "Find them in "
                : "Ask your organization's owner to connect it. Repositories live in "}
            <Link to="/settings/repositories">Settings → Repositories</Link>.
          </>
        )}
      </p>
    </div>
  );
}
