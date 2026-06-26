import { useEffect, useState } from "react";
import {
  addMcpConnection,
  deleteMcpConnection,
  getMcpConnections,
  updateMcpConnection,
  type McpConnection,
} from "../api/mcp";
import McpConnectClients from "./McpConnectClients";
import "./mcpPanel.css";

type AuthType = "none" | "bearer";

// Best-effort parse of a pasted server reference into {label, url, token}. Accepts:
//  - a bare URL ("https://mcp.acme.com/mcp")
//  - a `claude mcp add --transport http <name> <url> --header "Authorization: Bearer X"` command
//  - a JSON config snippet ({ "mcpServers": { "name": { "url": ..., "headers": {...} } } })
function parseServerInput(text: string): {
  label?: string;
  url?: string;
  token?: string;
} {
  const t = text.trim();
  if (!t) return {};

  // JSON config snippet (VS Code / Cursor / Claude Desktop shape).
  if (t.startsWith("{")) {
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const map = (obj.mcpServers ?? obj.servers ?? obj) as Record<string, unknown>;
      let name: string | undefined;
      let cfg: Record<string, unknown> = obj;
      if (map && typeof map === "object" && !("url" in map)) {
        const keys = Object.keys(map);
        if (keys.length) {
          name = keys[0];
          cfg = map[keys[0]] as Record<string, unknown>;
        }
      }
      const url = typeof cfg.url === "string" ? cfg.url : undefined;
      const headers = cfg.headers as Record<string, string> | undefined;
      const auth = headers?.Authorization ?? headers?.authorization;
      const token = auth?.replace(/^Bearer\s+/i, "").trim();
      if (url) return { label: name, url, token: token || undefined };
    } catch {
      // not JSON — fall through
    }
  }

  // URL anywhere in the text.
  const urlMatch = t.match(/https?:\/\/[^\s"',]+/);
  const url = urlMatch?.[0];
  if (!url) return {};

  const tokenMatch = t.match(/Bearer\s+([^"'\s]+)/i);
  const token = tokenMatch?.[1];

  // For a `claude mcp add` command, the server name is the bareword just before
  // the URL (skipping flags and transport keywords).
  let label: string | undefined;
  if (/mcp\s+add/i.test(t)) {
    const parts = t.split(/\s+/);
    const urlIdx = parts.findIndex((p) => /^https?:\/\//.test(p));
    const skip = new Set(["http", "sse", "stdio", "add", "mcp", "claude"]);
    for (let i = urlIdx - 1; i >= 0; i--) {
      const p = parts[i];
      if (!p || p.startsWith("-") || skip.has(p.toLowerCase())) continue;
      label = p;
      break;
    }
  }
  return { label, url, token };
}

function labelFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^(www|mcp|mcp-server)\./, "");
    return host.split(".")[0] || host;
  } catch {
    return "";
  }
}

// Connect remote MCP (Model Context Protocol) servers so the AI assistant can
// call their tools — e.g. read the org's own database. Enterprise org owners and
// platform owners only (the backend enforces the tier/scope gate). The auth
// token is write-only here and never returned.
export default function McpPanel() {
  const [connections, setConnections] = useState<McpConnection[] | null>(null);
  const [paste, setPaste] = useState("");
  const [label, setLabel] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [clientFor, setClientFor] = useState<number | null>(null);

  const load = () => {
    void getMcpConnections()
      .then(setConnections)
      .catch(() => setConnections([]));
  };
  useEffect(load, []);

  const fail = (e: unknown, fallback: string) =>
    setError(e instanceof Error ? e.message : fallback);

  // Smart paste: a URL / command / JSON snippet auto-fills the fields below.
  const onPaste = (text: string) => {
    setPaste(text);
    const parsed = parseServerInput(text);
    if (!parsed.url) return;
    setServerUrl(parsed.url);
    setLabel((cur) => parsed.label || cur || labelFromUrl(parsed.url || ""));
    if (parsed.token) {
      setAuthType("bearer");
      setToken(parsed.token);
    }
  };

  const canAdd = Boolean(label.trim() && serverUrl.trim()) && busy !== "add";

  const add = async () => {
    if (!label.trim() || !serverUrl.trim()) return;
    setBusy("add");
    setError(null);
    setMessage(null);
    const hasToken = authType === "bearer" && token.trim().length > 0;
    try {
      const created = await addMcpConnection({
        label: label.trim(),
        server_url: serverUrl.trim(),
        auth_token: hasToken ? token.trim() : undefined,
        auth_type: hasToken ? "bearer" : "none",
      });
      setPaste("");
      setLabel("");
      setServerUrl("");
      setToken("");
      setAuthType("none");
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
      if (clientFor === c.id) setClientFor(null);
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
      {/* ---- Add a server ---- */}
      <div className="mcp-add">
        <h3 className="mcp-add-title">Add a server</h3>

        <div className="mcp-field">
          <label className="mcp-label">Quick add</label>
          <textarea
            className="mcp-input mcp-textarea"
            rows={2}
            placeholder={
              'Paste a URL, a `claude mcp add …` command, or a JSON config — we’ll fill the fields below'
            }
            value={paste}
            onChange={(e) => onPaste(e.target.value)}
            autoComplete="off"
          />
          <span className="mcp-hint">
            …or fill them in manually:
          </span>
        </div>

        <div className="mcp-grid">
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
            <label className="mcp-label">Server URL (https)</label>
            <input
              className="mcp-input"
              placeholder="https://mcp.acme.com/mcp"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="mcp-field">
            <label className="mcp-label">Authentication</label>
            <select
              className="mcp-input mcp-select"
              value={authType}
              onChange={(e) => setAuthType(e.target.value as AuthType)}
            >
              <option value="none">No authentication</option>
              <option value="bearer">Bearer token</option>
            </select>
          </div>
          {authType === "bearer" && (
            <div className="mcp-field">
              <label className="mcp-label">Bearer token</label>
              <input
                type="password"
                className="mcp-input"
                placeholder="encrypted at rest · never shown again"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}
        </div>

        <button
          type="button"
          className="mcp-btn mcp-btn--primary"
          onClick={() => void add()}
          disabled={!canAdd}
        >
          {busy === "add" ? "Connecting…" : "Connect server"}
        </button>
      </div>

      {/* ---- Connected servers ---- */}
      {connections === null ? (
        <p className="mcp-muted">Loading…</p>
      ) : connections.length === 0 ? (
        <p className="mcp-muted">No MCP servers connected yet.</p>
      ) : (
        <ul className="mcp-list">
          {connections.map((c) => (
            <li key={c.id} className="mcp-item-wrap">
              <div className="mcp-item">
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
                    onClick={() =>
                      setClientFor((v) => (v === c.id ? null : c.id))
                    }
                  >
                    {clientFor === c.id ? "Hide clients" : "Connect a client"}
                  </button>
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
              </div>
              {clientFor === c.id && (
                <McpConnectClients label={c.label} serverUrl={c.server_url} />
              )}
            </li>
          ))}
        </ul>
      )}

      {message && <p className="mcp-ok">{message}</p>}
      {error && <p className="mcp-error">{error}</p>}
    </div>
  );
}
