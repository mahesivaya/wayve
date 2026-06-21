import { useEffect, useState } from "react";
import {
  connectGitlab,
  disconnectGitlab,
  getGitlabConnection,
  importGitlabIssues,
  type GitlabConnectionStatus,
} from "../api/gitlab";
import "./gitlabPanel.css";

const EMPTY: GitlabConnectionStatus = {
  connected: false,
  base_url: null,
  enabled: false,
};

// Connect a GitLab instance (gitlab.com or self-hosted) with a personal access
// token and import the issues assigned to you into Tasks.
export default function GitLabPanel() {
  const [status, setStatus] = useState<GitlabConnectionStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("https://gitlab.com");
  const [token, setToken] = useState("");
  const [state, setState] = useState<"opened" | "closed" | "all">("opened");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getGitlabConnection()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        if (s.base_url) setBaseUrl(s.base_url);
      })
      .catch(() => {
        if (!cancelled) setStatus(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fail = (e: unknown, fallback: string) =>
    setError(e instanceof Error ? e.message : fallback);

  const connect = async () => {
    if (!token.trim()) return;
    setBusy("connect");
    setError(null);
    setMessage(null);
    try {
      const s = await connectGitlab({
        base_url: baseUrl.trim(),
        access_token: token.trim(),
      });
      setStatus(s);
      setToken("");
      setMessage("Connected to GitLab.");
    } catch (e) {
      fail(e, "Could not connect. Check the instance URL and token.");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setError(null);
    try {
      await disconnectGitlab();
      setStatus(EMPTY);
      setMessage("Disconnected.");
    } catch (e) {
      fail(e, "Could not disconnect.");
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    setBusy("import");
    setError(null);
    setMessage(null);
    try {
      const r = await importGitlabIssues({ state });
      setMessage(
        `Imported ${r.imported} new + updated ${r.updated} task${
          r.updated === 1 ? "" : "s"
        } from GitLab.`
      );
    } catch (e) {
      fail(e, "Import failed.");
    } finally {
      setBusy(null);
    }
  };

  const connected = status?.connected ?? false;

  return (
    <div className="gl-panel">
      {!status ? (
        <p className="gl-muted">Loading…</p>
      ) : !connected ? (
        <div className="gl-connect">
          <p className="gl-muted">
            Paste a GitLab <strong>personal access token</strong> with the{" "}
            <code>read_api</code> scope (Settings → Access Tokens).
          </p>
          <label className="gl-field">
            <span>Instance URL</span>
            <input
              className="gl-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://gitlab.com"
            />
          </label>
          <label className="gl-field">
            <span>Access token</span>
            <input
              type="password"
              className="gl-input"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="glpat-…"
              autoComplete="off"
            />
          </label>
          <button
            type="button"
            className="gl-btn gl-btn--primary"
            onClick={() => void connect()}
            disabled={busy === "connect" || !token.trim()}
          >
            {busy === "connect" ? "Connecting…" : "Connect"}
          </button>
        </div>
      ) : (
        <div className="gl-connected">
          <p className="gl-muted">
            Connected to <strong>{status.base_url}</strong>. Importing pulls the
            issues assigned to you into Tasks.
          </p>
          <div className="gl-row">
            <label className="gl-field gl-field--inline">
              <span>Issues</span>
              <select
                className="gl-input"
                value={state}
                onChange={(e) =>
                  setState(e.target.value as "opened" | "closed" | "all")
                }
              >
                <option value="opened">Open</option>
                <option value="closed">Closed</option>
                <option value="all">All</option>
              </select>
            </label>
            <button
              type="button"
              className="gl-btn gl-btn--primary"
              onClick={() => void runImport()}
              disabled={busy === "import"}
            >
              {busy === "import" ? "Importing…" : "Import issues"}
            </button>
            <button
              type="button"
              className="gl-btn gl-btn--danger"
              onClick={() => void disconnect()}
              disabled={busy === "disconnect"}
            >
              Disconnect
            </button>
          </div>
        </div>
      )}

      {message && <p className="gl-ok">{message}</p>}
      {error && <p className="gl-error">{error}</p>}
    </div>
  );
}
