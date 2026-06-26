import { useState } from "react";

// Per-client "connect" picker for a registered MCP server. Given the server's
// URL, it shows the exact setup for each AI client. The bearer token is never
// returned by the API, so snippets use a <YOUR_TOKEN> placeholder; the optional
// field below fills them in client-side only (it is never sent anywhere).

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="mcp-copy"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Code({ text }: { text: string }) {
  return (
    <div className="mcp-code">
      <pre>{text}</pre>
      <CopyButton text={text} />
    </div>
  );
}

// A label like "Acme orders DB" → "acme-orders-db" for client config keys.
function safeName(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "my-mcp-server";
}

export default function McpConnectClients({
  label,
  serverUrl,
}: {
  label: string;
  serverUrl: string;
}) {
  const [token, setToken] = useState("");
  const name = safeName(label);
  const tok = token.trim() || "<YOUR_TOKEN>";

  const claudeCode = `claude mcp add --transport http ${name} ${serverUrl} \\\n  --header "Authorization: Bearer ${tok}"`;
  const codex = `# ~/.codex/config.toml\n[mcp_servers.${name}]\nurl = "${serverUrl}"\nbearer_token_env_var = "FLUXZE_MCP_TOKEN"\n\n# then, in your shell:\nexport FLUXZE_MCP_TOKEN="${tok}"`;
  const vscode = `// .vscode/mcp.json\n{\n  "servers": {\n    "${name}": {\n      "type": "http",\n      "url": "${serverUrl}",\n      "headers": { "Authorization": "Bearer ${tok}" }\n    }\n  }\n}`;
  const cursor = `// ~/.cursor/mcp.json\n{\n  "mcpServers": {\n    "${name}": {\n      "url": "${serverUrl}",\n      "headers": { "Authorization": "Bearer ${tok}" }\n    }\n  }\n}`;

  return (
    <div className="mcp-clients">
      <div className="mcp-field">
        <label className="mcp-label">
          Token to fill the snippets (optional · stays in your browser)
        </label>
        <input
          className="mcp-input"
          type="password"
          placeholder="paste your bearer token to auto-fill below"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
        />
      </div>

      <details className="mcp-client-row">
        <summary>Claude Code</summary>
        <p className="mcp-caveat">Run in your terminal:</p>
        <Code text={claudeCode} />
      </details>

      <details className="mcp-client-row">
        <summary>Codex CLI</summary>
        <p className="mcp-caveat">
          Codex reads the token from an env var (not inline):
        </p>
        <Code text={codex} />
      </details>

      <details className="mcp-client-row">
        <summary>Claude.ai</summary>
        <ol className="mcp-steps">
          <li>
            Settings → <strong>Connectors</strong> →{" "}
            <strong>Add custom connector</strong>.
          </li>
          <li>
            Paste this URL and click <strong>Add</strong>:
          </li>
        </ol>
        <Code text={serverUrl} />
        <p className="mcp-caveat">
          The Claude.ai UI has no bearer-token field — use a server that supports
          OAuth, or use Claude Code / Cursor / VS Code for token auth.
        </p>
      </details>

      <details className="mcp-client-row">
        <summary>ChatGPT</summary>
        <ol className="mcp-steps">
          <li>
            Turn on <strong>Developer mode</strong> in workspace settings.
          </li>
          <li>
            Settings → <strong>Apps &amp; Connectors</strong> →{" "}
            <strong>Create custom connector</strong>.
          </li>
          <li>Paste this URL (must be HTTPS):</li>
        </ol>
        <Code text={serverUrl} />
        <p className="mcp-caveat">
          OAuth-only; requires a paid plan with developer mode enabled.
        </p>
      </details>

      <details className="mcp-client-row">
        <summary>IDE (VS Code / Cursor)</summary>
        <p className="mcp-caveat">
          VS Code — <code>.vscode/mcp.json</code> (note <code>"type": "http"</code>
          ):
        </p>
        <Code text={vscode} />
        <p className="mcp-caveat">
          Cursor — <code>~/.cursor/mcp.json</code> (note <code>"mcpServers"</code>):
        </p>
        <Code text={cursor} />
      </details>
    </div>
  );
}
