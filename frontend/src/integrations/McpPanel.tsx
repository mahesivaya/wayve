import { useEffect, useState } from "react";
import {
  addMcpConnection,
  deleteMcpConnection,
  getMcpConnections,
  updateMcpConnection,
  type McpConnection,
} from "../api/mcp";
import "./mcpPanel.css";

// Connect remote MCP (Model Context Protocol) servers so the AI assistant can
// call their tools — e.g. read the org's own database. Enterprise org owners
// and platform owners only (the backend enforces the tier/scope gate). Fluxze
// never connects to the data store directly; it speaks MCP to a server the
// customer runs. The auth token is write-only here and never returned.
export default function McpPanel() {
  const [connections, setConnections] = useState<McpConnection[] | null>(null);
  const [label, setLabel] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => {
    void getMcpConnections()
      .then(setConnections)
      .catch(() => setConnections([]));
  };
  useEffect(load, []);

  const fail = (e: unknown, fallback: string) =>
    setError(e instanceof Error ? e.message : fallback);

  const add = async () => {
    if (!label.trim() || !serverUrl.trim()) return;
    setBusy("add");
    setError(null);
    setMessage(null);
    try {
      const created = await addMcpConnection({
        label: label.trim(),
        server_url: serverUrl.trim(),
        auth_token: token.trim() || undefined,
        auth_type: token.trim() ? "bearer" : "none",
      });
      setLabel("");
      setServerUrl("");
      setToken("");
      setMessage(
        `Connected ${created.label} · ${created.last_tool_count ?? 0} tool${
          created.last_tool_count === 1 ? "" : "s"
        }.`
      );
      load();
    } catch (e) {
      fail(e, "Could not connect. Check the URL and token.");
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (c: McpConnection) => {
    setBusy(`toggle:${c.id}`);
    setError(null);
    try {
      await updateMcpConnection(c.id, { enabled: !c.enabled });
      load();
    } catch (e) {
      fail(e, "Could not update the connection.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (c: McpConnection) => {
    setBusy(`del:${c.id}`);
    setError(null);
    setMessage(null);
    try {
      await deleteMcpConnection(c.id);
      setMessage(`Removed ${c.label}.`);
      load();
    } catch (e) {
      fail(e, "Could not remove the connection.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mcp-panel">
      <details className="mcp-guide">
        <summary>📖 What is this — and how to connect</summary>
        <p className="mcp-muted">
          An <strong>MCP server</strong> is a small service <em>you</em> run that
          exposes tools (e.g. a read-only query over your database) over the{" "}
          <a
            href="https://modelcontextprotocol.io"
            target="_blank"
            rel="noopener noreferrer"
          >
            Model Context Protocol
          </a>
          . Connect one here and Fluxze's AI can call those tools to answer
          questions from your own systems. Fluxze only ever talks to the server
          you point it at — it never touches your database directly.
        </p>
        <ol className="mcp-guide-list">
          <li>
            Stand up a <strong>remote</strong> MCP server reachable over{" "}
            <code>https</code> (the Streamable-HTTP transport). Local{" "}
            <code>stdio</code> servers can't be reached from Fluxze.
          </li>
          <li>
            Give it a label, paste its URL, and (if it needs one) a bearer token.
          </li>
          <li>
            We validate it immediately by handshaking and listing its tools, then
            store the token encrypted at rest.
          </li>
        </ol>
      </details>

      <div className="mcp-add">
        <div className="mcp-field">
          <label className="mcp-label">Label</label>
          <input
            className="mcp-input"
            placeholder="Acme orders DB"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="mcp-field">
          <label className="mcp-label">Server URL</label>
          <input
            className="mcp-input"
            placeholder="https://mcp.acme.com/mcp"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="mcp-field">
          <label className="mcp-label">Bearer token (optional)</label>
          <input
            type="password"
            className="mcp-input"
            placeholder="leave blank if the server needs no auth"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </div>
        <button
          type="button"
          className="mcp-btn mcp-btn--primary"
          onClick={() => void add()}
          disabled={busy === "add" || !label.trim() || !serverUrl.trim()}
        >
          {busy === "add" ? "Connecting…" : "Connect server"}
        </button>
      </div>

      {connections === null ? (
        <p className="mcp-muted">Loading…</p>
      ) : connections.length === 0 ? (
        <p className="mcp-muted">No MCP servers connected yet.</p>
      ) : (
        <ul className="mcp-list">
          {connections.map((c) => (
            <li key={c.id} className="mcp-item">
              <div className="mcp-item-main">
                <span className="mcp-item-label">{c.label}</span>
                <span className="mcp-item-meta">
                  {c.server_name ? `${c.server_name} · ` : ""}
                  {c.last_tool_count ?? 0} tool
                  {c.last_tool_count === 1 ? "" : "s"}
                  {c.enabled ? "" : " · disabled"}
                </span>
                <span className="mcp-item-url">{c.server_url}</span>
              </div>
              <div className="mcp-row">
                <button
                  type="button"
                  className="mcp-btn"
                  onClick={() => void toggle(c)}
                  disabled={busy === `toggle:${c.id}`}
                >
                  {c.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  className="mcp-btn mcp-btn--danger"
                  onClick={() => void remove(c)}
                  disabled={busy === `del:${c.id}`}
                >
                  {busy === `del:${c.id}` ? "Removing…" : "Remove"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {message && <p className="mcp-ok">{message}</p>}
      {error && <p className="mcp-error">{error}</p>}
    </div>
  );
}
