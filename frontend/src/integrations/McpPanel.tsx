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

// Curated connection blocks that pre-fill the form. The URL stays editable so an
// owner can point at their own tenant or region, and the auth defaults are only a
// starting point — the owner always supplies the token. "Custom" starts blank and
// reveals the smart-paste box.
type McpPreset = {
  id: string;
  label: string;
  vendor: string;
  blurb: string;
  url: string;
  auth: AuthType;
  custom?: boolean;
};

const MCP_PRESETS: McpPreset[] = [
  {
    id: "github",
    label: "GitHub",
    vendor: "github.com",
    blurb: "Repos, issues & pull requests",
    url: "https://api.githubcopilot.com/mcp/",
    auth: "bearer",
  },
  {
    id: "linear",
    label: "Linear",
    vendor: "linear.app",
    blurb: "Issues & project tracking",
    url: "https://mcp.linear.app/sse",
    auth: "bearer",
  },
  {
    id: "notion",
    label: "Notion",
    vendor: "notion.so",
    blurb: "Pages & databases",
    url: "https://mcp.notion.com/mcp",
    auth: "bearer",
  },
  {
    id: "sentry",
    label: "Sentry",
    vendor: "sentry.io",
    blurb: "Errors, issues & releases",
    url: "https://mcp.sentry.dev/mcp",
    auth: "bearer",
  },
  {
    id: "stripe",
    label: "Stripe",
    vendor: "stripe.com",
    blurb: "Payments & billing data",
    url: "https://mcp.stripe.com",
    auth: "bearer",
  },
  {
    id: "atlassian",
    label: "Atlassian",
    vendor: "atlassian.com",
    blurb: "Jira & Confluence",
    url: "https://mcp.atlassian.com/v1/sse",
    auth: "bearer",
  },
  {
    id: "custom",
    label: "Custom server",
    vendor: "Any remote MCP",
    blurb: "Paste a URL, command or JSON config",
    url: "",
    auth: "none",
    custom: true,
  },
];

// Best-effort parse of a pasted server reference into {label, url, token}. Accepts
// a bare URL, a `claude mcp add ...` command, or a JSON config snippet.
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

  const urlMatch = t.match(/https?:\/\/[^\s"',]+/);
  const url = urlMatch?.[0];
  if (!url) return {};

  const tokenMatch = t.match(/Bearer\s+([^"'\s]+)/i);
  const token = tokenMatch?.[1];

  // In a `claude mcp add` command the server name is the bareword just before the
  // URL, once flags and transport keywords are skipped.
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

// Bare lowercased hostname, used to match a connected server back to its preset
// block. Returns "" for an unparseable URL.
function urlHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Connect remote MCP servers so the AI assistant can call their tools. Enterprise
// org owners and platform owners only, enforced by the backend. The auth token is
// write-only: the API never returns it.
export default function McpPanel() {
  const [connections, setConnections] = useState<McpConnection[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [label, setLabel] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [clientFor, setClientFor] = useState<number | null>(null);
  const [settingsFor, setSettingsFor] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editToken, setEditToken] = useState("");

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

  const pick = (preset: McpPreset) => {
    setSelected(preset.id);
    setError(null);
    setMessage(null);
    setPaste("");
    setToken("");
    if (preset.custom) {
      setLabel("");
      setServerUrl("");
      setAuthType("none");
    } else {
      setLabel(preset.label);
      setServerUrl(preset.url);
      setAuthType(preset.auth);
    }
  };

  const isCustom = MCP_PRESETS.find((p) => p.id === selected)?.custom ?? false;
  const canAdd = Boolean(label.trim() && serverUrl.trim()) && busy !== "add";

  // Hosts of registered servers, so a preset block can flag itself as connected.
  const connectedHosts = new Set(
    (connections ?? []).map((c) => urlHost(c.server_url)).filter(Boolean)
  );

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
      setSelected(null);
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

  // The token field starts blank because it is rotate-only: the API never returns
  // the stored value.
  const openSettings = (c: McpConnection) => {
    setError(null);
    setMessage(null);
    if (settingsFor === c.id) {
      setSettingsFor(null);
      return;
    }
    setSettingsFor(c.id);
    setClientFor(null);
    setEditLabel(c.label);
    setEditUrl(c.server_url);
    setEditToken("");
  };

  const saveSettings = async (c: McpConnection) => {
    if (!editLabel.trim() || !editUrl.trim()) return;
    setBusy(`save:${c.id}`);
    setError(null);
    setMessage(null);
    const rotate = editToken.trim();
    try {
      await updateMcpConnection(c.id, {
        label: editLabel.trim(),
        server_url: editUrl.trim(),
        auth_token: rotate ? rotate : undefined,
      });
      setSettingsFor(null);
      setEditToken("");
      setMessage(`Updated ${editLabel.trim()}.`);
      load();
    } catch (e) {
      fail(e, "Could not save changes.");
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
      if (settingsFor === c.id) setSettingsFor(null);
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

        {/* Connection blocks — pick one to pre-fill the fields below. */}
        <div
          className="mcp-block-grid"
          role="radiogroup"
          aria-label="MCP server"
        >
          {MCP_PRESETS.map((p) => {
            const connected = !p.custom && connectedHosts.has(urlHost(p.url));
            return (
              <button
                type="button"
                key={p.id}
                role="radio"
                aria-checked={selected === p.id}
                className={`mcp-block ${selected === p.id ? "is-selected" : ""}`}
                onClick={() => pick(p)}
              >
                <span className="mcp-block-radio" aria-hidden="true" />
                <span className="mcp-block-label">{p.label}</span>
                <span className="mcp-block-vendor">{p.vendor}</span>
                <span className="mcp-block-blurb">{p.blurb}</span>
                {connected && <span className="mcp-block-active">Connected</span>}
              </button>
            );
          })}
        </div>

        {selected && (
          <>
            {isCustom && (
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
                <span className="mcp-hint">…or fill them in manually:</span>
              </div>
            )}

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
          </>
        )}
      </div>

      {/* ---- Connected servers (central management) ---- */}
      <div className="mcp-manage">
        <div className="mcp-manage-head">
          <h3 className="mcp-add-title">Your MCP servers</h3>
          {connections && connections.length > 0 && (
            <span className="mcp-count">
              {connections.filter((c) => c.enabled).length} of{" "}
              {connections.length} enabled
            </span>
          )}
        </div>

        {connections === null ? (
          <p className="mcp-muted">Loading…</p>
        ) : connections.length === 0 ? (
          <p className="mcp-muted">No MCP servers connected yet.</p>
        ) : (
          <ul className="mcp-list">
            {connections.map((c) => (
              <li key={c.id} className="mcp-item-wrap">
                <div className="mcp-item">
                  <label
                    className="mcp-switch"
                    aria-label={`${c.enabled ? "Disable" : "Enable"} ${c.label}`}
                  >
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={() => void toggle(c)}
                      disabled={busy === `toggle:${c.id}`}
                    />
                    <span className="mcp-switch-track" aria-hidden="true">
                      <span className="mcp-switch-thumb" />
                    </span>
                  </label>
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
                      aria-expanded={settingsFor === c.id}
                      onClick={() => openSettings(c)}
                    >
                      {settingsFor === c.id ? "Close settings" : "Settings"}
                    </button>
                    <button
                      type="button"
                      className="mcp-btn"
                      onClick={() =>
                        setClientFor((v) => (v === c.id ? null : c.id))
                      }
                    >
                      {clientFor === c.id ? "Hide clients" : "Connect a client"}
                    </button>
                  </div>
                </div>

                {settingsFor === c.id && (
                  <div className="mcp-settings">
                    <div className="mcp-grid">
                      <div className="mcp-field">
                        <label className="mcp-label">Label</label>
                        <input
                          className="mcp-input"
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                        />
                      </div>
                      <div className="mcp-field">
                        <label className="mcp-label">Server URL (https)</label>
                        <input
                          className="mcp-input"
                          value={editUrl}
                          onChange={(e) => setEditUrl(e.target.value)}
                          autoComplete="off"
                        />
                      </div>
                      <div className="mcp-field">
                        <label className="mcp-label">Rotate token</label>
                        <input
                          type="password"
                          className="mcp-input"
                          placeholder="leave blank to keep the current token"
                          value={editToken}
                          onChange={(e) => setEditToken(e.target.value)}
                          autoComplete="off"
                        />
                      </div>
                    </div>
                    <div className="mcp-row">
                      <button
                        type="button"
                        className="mcp-btn mcp-btn--primary"
                        onClick={() => void saveSettings(c)}
                        disabled={
                          busy === `save:${c.id}` ||
                          !editLabel.trim() ||
                          !editUrl.trim()
                        }
                      >
                        {busy === `save:${c.id}` ? "Saving…" : "Save changes"}
                      </button>
                      <button
                        type="button"
                        className="mcp-btn mcp-btn--danger"
                        onClick={() => void remove(c)}
                        disabled={busy === `del:${c.id}`}
                      >
                        {busy === `del:${c.id}` ? "Removing…" : "Remove server"}
                      </button>
                    </div>
                  </div>
                )}

                {clientFor === c.id && (
                  <McpConnectClients label={c.label} serverUrl={c.server_url} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {message && <p className="mcp-ok">{message}</p>}
      {error && <p className="mcp-error">{error}</p>}
    </div>
  );
}
