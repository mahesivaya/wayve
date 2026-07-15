import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  connectJira,
  disconnectJira,
  getJiraConnection,
  importJiraIssues,
  type JiraConnectionStatus,
} from "../api/jira";
import type { Task } from "../api/tasks";
import "./jiraPanel.css";

/**
 * Per-user Jira connection + on-demand issue import. Disconnected: a base
 * URL / email / API token form. Connected: the linked account, an "Import
 * from Jira" button (which refreshes the task list via `onImported`), and a
 * Disconnect button. The API token is write-only — it is never returned by the
 * backend, so it's never shown back here.
 */
export default function JiraPanel({ onImported }: { onImported: () => void }) {
  const [status, setStatus] = useState<JiraConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");

  // Optional JQL to scope the import. Empty → backend default ("my open
  // issues"). e.g. `project = KAN` imports a whole board/project.
  const [jql, setJql] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getJiraConnection());
    } catch {
      setStatus({
        connected: false,
        base_url: null,
        email: null,
        enabled: false,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // Deferred to a microtask so the effect body doesn't synchronously call
  // setState — the React 19 "set-state-in-effect" rule flags the direct
  // pattern as cascading-render risk. Same wrapper as Tasks.tsx's load effect.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const submitConnect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!baseUrl.trim() || !email.trim() || !apiToken.trim()) {
      setError("Site URL, email, and API token are all required.");
      return;
    }
    setBusy(true);
    try {
      const next = await connectJira({
        base_url: baseUrl.trim(),
        email: email.trim(),
        api_token: apiToken.trim(),
      });
      setStatus(next);
      setApiToken("");
      setOpen(false);
      setNotice("Jira connected.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not connect to Jira."
      );
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = await importJiraIssues(
        jql.trim() ? { jql: jql.trim() } : undefined
      );
      setNotice(
        `Imported ${result.imported}, updated ${result.updated} issue${
          result.imported + result.updated === 1 ? "" : "s"
        }.`
      );
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  const runDisconnect = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await disconnectJira();
      setStatus({
        connected: false,
        base_url: null,
        email: null,
        enabled: false,
      });
      setNotice("Jira disconnected.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;

  const connected = status?.connected ?? false;

  return (
    <section className="jira-panel">
      <div className="jira-panel-head">
        <span className="jira-panel-title">Jira</span>
        {connected ? (
          <span className="jira-panel-account">
            Connected as <strong>{status?.email}</strong>
            {status?.base_url ? ` · ${status.base_url}` : ""}
          </span>
        ) : (
          <span className="jira-panel-account jira-panel-account--off">
            Not connected
          </span>
        )}
        <div className="jira-panel-actions">
          {connected ? (
            <>
              <button
                type="button"
                className="jira-btn jira-btn--primary"
                onClick={() => void runImport()}
                disabled={busy}
              >
                {busy ? "Importing…" : "Import from Jira"}
              </button>
              <button
                type="button"
                className="jira-btn"
                onClick={() => void runDisconnect()}
                disabled={busy}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              className="jira-btn jira-btn--primary"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Cancel" : "Connect Jira"}
            </button>
          )}
        </div>
      </div>

      {connected && (
        <div className="jira-import-scope">
          <input
            className="jira-jql-input"
            value={jql}
            onChange={(e) => setJql(e.target.value)}
            placeholder="JQL filter (optional) — e.g. project = KAN"
            spellCheck={false}
          />
          <span className="jira-jql-hint">
            Leave blank to import your open issues. Use JQL to widen the scope,
            e.g. <code>project = KAN</code> for a whole board.
          </span>
        </div>
      )}

      {notice && <p className="jira-panel-notice">{notice}</p>}
      {error && <p className="jira-panel-error">{error}</p>}

      {!connected && open && (
        <form className="jira-panel-form" onSubmit={submitConnect}>
          <label className="jira-field">
            <span>Site URL</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://your-site.atlassian.net"
            />
          </label>
          <label className="jira-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <label className="jira-field">
            <span>API token</span>
            <input
              type="password"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              placeholder="Atlassian API token"
              autoComplete="off"
            />
          </label>
          <button
            type="submit"
            className="jira-btn jira-btn--primary"
            disabled={busy}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * A small deep-link badge shown on tasks imported from Jira. Renders nothing
 * for non-Jira tasks. Links to `${jira_base}/browse/${jira_issue_key}`.
 */
export function JiraBadge({ task }: { task: Task }) {
  if (!task.jira_issue_key) return null;
  const href = task.jira_base
    ? `${task.jira_base}/browse/${task.jira_issue_key}`
    : undefined;
  if (!href) {
    return <span className="jira-badge">{task.jira_issue_key}</span>;
  }
  return (
    <a
      className="jira-badge jira-badge--link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${task.jira_issue_key} in Jira`}
      onClick={(e) => e.stopPropagation()}
    >
      {task.jira_issue_key}
    </a>
  );
}
