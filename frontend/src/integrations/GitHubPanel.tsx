import { useCallback, useEffect, useState } from "react";
import {
  disconnectGithub,
  getGithubConnection,
  getGithubConnectUrl,
  type GithubConnection,
} from "../api/github";

/**
 * Per-user GitHub connect (OAuth) shown inline on the Integrations page.
 * Disconnected: a "Connect GitHub" button that starts the OAuth redirect.
 * Connected: the linked login + a Disconnect button. After OAuth the backend
 * callback returns to the Code Repo page, where repos are imported/browsed.
 */
export default function GitHubPanel({
  onChange,
}: {
  onChange?: (connected: boolean) => void;
}) {
  const [status, setStatus] = useState<GithubConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getGithubConnection();
      setStatus(s);
      onChange?.(s.connected);
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, [onChange]);

  // Deferred to a microtask so the effect body doesn't synchronously setState
  // (matches JiraPanel's pattern).
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const connect = async () => {
    setError("");
    setBusy(true);
    try {
      window.location.href = await getGithubConnectUrl();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start the GitHub connect."
      );
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setError("");
    setBusy(true);
    try {
      await disconnectGithub();
      setStatus({ connected: false });
      onChange?.(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;
  const connected = status?.connected ?? false;

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

      <div className="github-panel-actions">
        {connected ? (
          <button
            type="button"
            className="integrations-info-btn"
            onClick={() => void disconnect()}
            disabled={busy}
          >
            Disconnect
          </button>
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

      <p className="integrations-info-text">
        Connecting authorizes Fluxze to read your repositories. Import and browse
        them from the Code Repo page.
      </p>
    </div>
  );
}
