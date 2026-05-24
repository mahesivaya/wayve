import { FormEvent, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import {
  API_SCOPES,
  createApiKey,
  CreatedApiKey,
  type ApiScope,
  type KeyType,
} from "../api/apiKeys";
import { apiFetchJson } from "../api/client";
import { getApiBase } from "../config/env";
import "./platformTeam.css";

const EMBED_SCOPES = [
  "profile:read",
  "email:read",
  "chat:read",
  "scheduler:read",
  "drive:read",
  "notes:read",
  "tasks:read",
];

type EmbedMintResponse = {
  token: string;
  expires_in: number;
  origin: string;
  scopes: string[];
};

// Test endpoints — read-only paths so testing a key never mutates state.
// Each one is annotated with the scope it needs so the owner can predict
// which keys should succeed vs. be denied for scope-mismatch.
const TEST_ENDPOINTS: Array<{ method: "GET"; path: string; scope: ApiScope }> = [
  { method: "GET", path: "/api/me", scope: "profile:read" },
  { method: "GET", path: "/api/v1/me", scope: "profile:read" },
  { method: "GET", path: "/api/tasks", scope: "tasks:read" },
  { method: "GET", path: "/api/notes", scope: "notes:read" },
  { method: "GET", path: "/api/emails", scope: "email:read" },
];

type TestResult = {
  status: number;
  ok: boolean;
  body: string;
  durationMs: number;
};

export default function PlatformSecrets() {
  const { user } = useAuth();
  // Owner-only: this page mints platform-wide credentials. Even super_admin
  // is intentionally excluded — they bypass billing checks but should not
  // be able to provision a `*`-scoped internal key.
  const canView =
    user?.scope === "platform" && user?.effective_role === "owner";

  // ── Create form ────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [keyType, setKeyType] = useState<KeyType>("external");
  const [fullAccess, setFullAccess] = useState(false);
  const [scopes, setScopes] = useState<Set<string>>(
    () => new Set<string>(["profile:read"]),
  );
  const [expiresAt, setExpiresAt] = useState("");
  const [rateLimit, setRateLimit] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  // ── Test panel ────────────────────────────────────────────────────
  const [testKey, setTestKey] = useState("");
  const [testEndpoint, setTestEndpoint] = useState(TEST_ENDPOINTS[0].path);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState("");

  // ── Embed token mint ──────────────────────────────────────────────
  const [embedOrigin, setEmbedOrigin] = useState("https://customer.example");
  const [embedScopes, setEmbedScopes] = useState<Set<string>>(
    () => new Set(["profile:read"]),
  );
  const [embedMinting, setEmbedMinting] = useState(false);
  const [embedError, setEmbedError] = useState("");
  const [embedResult, setEmbedResult] = useState<EmbedMintResponse | null>(null);

  const toggleEmbedScope = (scope: string) => {
    setEmbedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  const mintEmbedToken = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setEmbedError("");
    setEmbedResult(null);
    setEmbedMinting(true);
    try {
      const result = await apiFetchJson<EmbedMintResponse>("/api/embed/tokens", {
        method: "POST",
        body: JSON.stringify({
          origin: embedOrigin.trim(),
          scopes: [...embedScopes],
        }),
      });
      setEmbedResult(result);
    } catch (err) {
      setEmbedError(err instanceof Error ? err.message : "Failed to mint embed token");
    } finally {
      setEmbedMinting(false);
    }
  };

  const toggleScope = (scope: string) => {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError("");
    setCreated(null);
    const selectedScopes =
      keyType === "internal" && fullAccess ? ["*"] : [...scopes];
    if (keyType === "external" && selectedScopes.length === 0) {
      setCreateError("External keys must declare at least one scope.");
      return;
    }
    if (keyType === "external" && !expiresAt) {
      setCreateError("External keys require an expiry date.");
      return;
    }
    setCreating(true);
    try {
      const result = await createApiKey({
        name: name.trim(),
        key_type: keyType,
        scopes: selectedScopes,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        rate_limit_per_min: rateLimit ? Number(rateLimit) : undefined,
      });
      setCreated(result);
      // Pre-fill the test box so the owner can run the very next click
      // without copy-paste — the raw key is only available right now.
      setTestKey(result.api_key);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setCreating(false);
    }
  };

  // Raw fetch so the request carries ONLY X-API-KEY — no JWT bearer and no
  // 401-driven auth/redirect from the shared apiFetch wrapper.
  const runTest = async () => {
    setTestError("");
    setTestResult(null);
    if (!testKey.trim()) {
      setTestError("Paste an API key (or create one above first).");
      return;
    }
    setTesting(true);
    const started = performance.now();
    try {
      const response = await fetch(`${getApiBase()}${testEndpoint}`, {
        method: "GET",
        headers: {
          "X-API-KEY": testKey.trim(),
          Accept: "application/json",
        },
      });
      const body = await response.text();
      setTestResult({
        status: response.status,
        ok: response.ok,
        body,
        durationMs: Math.round(performance.now() - started),
      });
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setTesting(false);
    }
  };

  if (!canView) return <Navigate to="/" replace />;

  return (
    <div className="pt-page">
      <header className="pt-header">
        <h1>API Secrets — Owner Console</h1>
        <p>
          Mint API keys (including <code>*</code>-scoped internal keys) and test
          them against the live API. Only the platform owner can reach this page.
        </p>
      </header>

      <section className="pt-panel">
        <div className="pt-panel-head">
          <h2>1. Create secret</h2>
          <Link to="/api-keys" className="pt-link">All keys →</Link>
        </div>
        <form className="api-secrets-form" onSubmit={submitCreate}>
          <label>
            Name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. CI pipeline, mobile app, billing webhook"
            />
          </label>

          <label>
            Key type
            <select
              value={keyType}
              onChange={(e) => {
                setKeyType(e.target.value as KeyType);
                setFullAccess(false);
              }}
            >
              <option value="external">External — explicit scopes, expiry required</option>
              <option value="internal">Internal — may hold `*` (full access)</option>
            </select>
          </label>

          {keyType === "internal" && (
            <label className="api-secrets-checkbox">
              <input
                type="checkbox"
                checked={fullAccess}
                onChange={(e) => setFullAccess(e.target.checked)}
              />
              <span>Full access (<code>*</code> — every scope, no expiry needed)</span>
            </label>
          )}

          {!(keyType === "internal" && fullAccess) && (
            <fieldset className="api-secrets-scopes">
              <legend>Scopes</legend>
              {API_SCOPES.map((scope) => (
                <label key={scope} className="api-secrets-checkbox">
                  <input
                    type="checkbox"
                    checked={scopes.has(scope)}
                    onChange={() => toggleScope(scope)}
                  />
                  <span>{scope}</span>
                </label>
              ))}
            </fieldset>
          )}

          <label>
            Expires {keyType === "external" ? "(required)" : "(optional)"}
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              required={keyType === "external"}
            />
          </label>

          <label>
            Rate limit (requests/min — optional)
            <input
              type="number"
              min={1}
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.value)}
              placeholder={keyType === "internal" ? "6000" : "120"}
            />
          </label>

          <div className="api-secrets-actions">
            <button type="submit" className="pt-link-btn" disabled={creating}>
              {creating ? "Creating…" : "Create secret"}
            </button>
          </div>
        </form>

        {createError && <div className="pt-banner">{createError}</div>}

        {created && (
          <div className="api-secrets-reveal">
            <strong>Copy this key now — it is shown only once:</strong>
            <code className="api-secrets-raw">{created.api_key}</code>
            <p className="pt-stat-sub">
              Created <em>{created.name}</em> · {created.key_type} ·{" "}
              {created.scopes.join(", ") || "no scopes"} · {created.rate_limit_per_min}/min
            </p>
          </div>
        )}
      </section>

      <section className="pt-panel">
        <div className="pt-panel-head">
          <h2>2. Test secret</h2>
          <span className="pt-stat-sub">
            Sends a read-only GET to the live API with <code>X-API-KEY</code>
          </span>
        </div>

        <div className="api-secrets-test">
          <label>
            API key
            <input
              value={testKey}
              onChange={(e) => setTestKey(e.target.value)}
              placeholder="Paste a key, or create one above"
              spellCheck={false}
            />
          </label>

          <label>
            Endpoint
            <select
              value={testEndpoint}
              onChange={(e) => setTestEndpoint(e.target.value)}
            >
              {TEST_ENDPOINTS.map((ep) => (
                <option key={ep.path} value={ep.path}>
                  {ep.method} {ep.path} (needs <code>{ep.scope}</code>)
                </option>
              ))}
            </select>
          </label>

          <div className="api-secrets-actions">
            <button
              type="button"
              className="pt-link-btn"
              onClick={() => void runTest()}
              disabled={testing}
            >
              {testing ? "Calling…" : "Send test request"}
            </button>
          </div>
        </div>

        {testError && <div className="pt-banner">{testError}</div>}

        {testResult && (
          <div
            className={`api-secrets-result ${testResult.ok ? "ok" : "fail"}`}
          >
            <div className="api-secrets-result-head">
              <span className={`pt-pill ${testResult.ok ? "ok" : "error"}`}>
                HTTP {testResult.status}
              </span>
              <span className="pt-stat-sub">{testResult.durationMs}ms</span>
            </div>
            <pre className="api-secrets-result-body">{prettyJson(testResult.body)}</pre>
          </div>
        )}

        <p className="pt-stat-sub" style={{ marginTop: 12 }}>
          A <strong>200</strong> means the key is valid and in scope. A{" "}
          <strong>401</strong> means the key is unknown / revoked / expired. A{" "}
          <strong>403</strong> means the key is valid but lacks the scope shown
          next to the endpoint. <strong>429</strong> means the per-key rate
          limit was hit.
        </p>
      </section>

      <section className="pt-panel">
        <div className="pt-panel-head">
          <h2>3. Embed token (read-only iframe)</h2>
          <span className="pt-stat-sub">
            5-minute TTL · origin-pinned · GET only · sent as{" "}
            <code>X-EMBED-TOKEN</code>
          </span>
        </div>
        <form className="api-secrets-form" onSubmit={(e) => void mintEmbedToken(e)}>
          <label>
            Embedding origin
            <input
              required
              value={embedOrigin}
              onChange={(e) => setEmbedOrigin(e.target.value)}
              placeholder="https://customer.example"
            />
          </label>
          <fieldset className="api-secrets-scopes">
            <legend>Read scopes</legend>
            {EMBED_SCOPES.map((scope) => (
              <label key={scope} className="api-secrets-checkbox">
                <input
                  type="checkbox"
                  checked={embedScopes.has(scope)}
                  onChange={() => toggleEmbedScope(scope)}
                />
                <span>{scope}</span>
              </label>
            ))}
          </fieldset>
          <div className="api-secrets-actions">
            <button type="submit" className="pt-link-btn" disabled={embedMinting}>
              {embedMinting ? "Minting…" : "Mint embed token"}
            </button>
          </div>
        </form>

        {embedError && <div className="pt-banner">{embedError}</div>}

        {embedResult && (
          <div className="api-secrets-reveal">
            <strong>
              Embed token (expires in {embedResult.expires_in}s, pinned to{" "}
              <code>{embedResult.origin}</code>):
            </strong>
            <code className="api-secrets-raw">{embedResult.token}</code>
            <p className="pt-stat-sub">
              Pass this in <code>X-EMBED-TOKEN</code> header from the embedding
              origin. Wayve rejects the request if{" "}
              <code>Origin: {embedResult.origin}</code> is missing or the method
              is not GET/HEAD.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
