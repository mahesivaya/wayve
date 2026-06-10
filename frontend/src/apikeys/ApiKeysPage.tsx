import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  API_SCOPES,
  createApiKey,
  getApiKeyAudit,
  listApiKeys,
  revokeApiKey,
  type ApiKey,
  type ApiKeyAuditRow,
  type KeyType,
} from "../api/apiKeys";
import { fmtDateTime } from "../utils/datetime";
import "./apiKeys.css";

export default function ApiKeysPage() {
  const { user } = useAuth();
  const canManage = hasPermission(user, "api_keys:manage");
  const isPlatform = user?.scope === "platform";

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create form.
  const [name, setName] = useState("");
  const [keyType, setKeyType] = useState<KeyType>("external");
  const [fullAccess, setFullAccess] = useState(false);
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [expiresAt, setExpiresAt] = useState("");
  const [rateLimit, setRateLimit] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [newRawKey, setNewRawKey] = useState("");

  // Audit viewer.
  const [auditFor, setAuditFor] = useState<number | null>(null);
  const [auditRows, setAuditRows] = useState<ApiKeyAuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  useEffect(() => {
    // Without api_keys:manage the page renders a notice instead (see below),
    // so there is no list to load and no loading state to clear here.
    if (!canManage) return;

    let alive = true;
    listApiKeys()
      .then((items) => {
        if (alive) setKeys(items);
      })
      .catch((err) => {
        if (alive)
          setError(err instanceof Error ? err.message : "Failed to load keys");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [canManage]);

  const toggleScope = (scope: string) => {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        next.delete(scope);
      } else {
        next.add(scope);
      }
      return next;
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError("");
    setNewRawKey("");
    const selectedScopes =
      keyType === "internal" && fullAccess ? ["*"] : [...scopes];
    setCreating(true);
    try {
      const created = await createApiKey({
        name: name.trim(),
        key_type: keyType,
        scopes: selectedScopes,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        rate_limit_per_min: rateLimit ? Number(rateLimit) : undefined,
      });
      setNewRawKey(created.api_key);
      setKeys((prev) => [created, ...prev]);
      setName("");
      setScopes(new Set());
      setExpiresAt("");
      setRateLimit("");
      setFullAccess(false);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to create key"
      );
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: number) => {
    setError("");
    try {
      await revokeApiKey(id);
      setKeys((prev) =>
        prev.map((key) =>
          key.id === id ? { ...key, revoked_at: new Date().toISOString() } : key
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke key");
    }
  };

  const openAudit = async (id: number) => {
    setAuditFor(id);
    setAuditRows([]);
    setAuditLoading(true);
    try {
      setAuditRows(await getApiKeyAudit(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      setAuditLoading(false);
    }
  };

  if (!canManage) {
    return (
      <div className="api-keys-page">
        <h1>API Keys</h1>
        <p className="api-keys-empty">
          You do not have permission to manage API keys.
        </p>
      </div>
    );
  }

  return (
    <div className="api-keys-page">
      <h1>API Keys</h1>
      <p className="api-keys-intro">
        Keys authenticate applications without a login. Each request runs as the
        key's user, limited to its scopes, rate limit and expiry.
      </p>

      {/* CREATE */}
      <section className="api-keys-panel">
        <h2>Create key</h2>
        <form className="api-keys-form" onSubmit={submit}>
          <label>
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. CI pipeline"
              required
            />
          </label>

          <label>
            <span>Type</span>
            <select
              value={keyType}
              onChange={(e) => {
                setKeyType(e.target.value as KeyType);
                setFullAccess(false);
              }}
            >
              <option value="external">
                External — explicit scopes, expiry required
              </option>
              {isPlatform && (
                <option value="internal">
                  Internal — may hold full access
                </option>
              )}
            </select>
          </label>

          {keyType === "internal" && (
            <label className="api-keys-checkbox">
              <input
                type="checkbox"
                checked={fullAccess}
                onChange={(e) => setFullAccess(e.target.checked)}
              />
              <span>Full access (&lowast; — every scope)</span>
            </label>
          )}

          {!(keyType === "internal" && fullAccess) && (
            <fieldset className="api-keys-scopes">
              <legend>Scopes</legend>
              {API_SCOPES.map((scope) => (
                <label key={scope} className="api-keys-checkbox">
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
            <span>
              Expires{keyType === "external" ? " (required)" : " (optional)"}
            </span>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              required={keyType === "external"}
            />
          </label>

          <label>
            <span>Rate limit (requests/min — optional)</span>
            <input
              type="number"
              min={1}
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.value)}
              placeholder={keyType === "internal" ? "6000" : "120"}
            />
          </label>

          <button type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create key"}
          </button>
        </form>

        {createError && <div className="api-keys-error">{createError}</div>}
        {newRawKey && (
          <div className="api-keys-reveal">
            <strong>Copy this key now — it is shown only once:</strong>
            <code>{newRawKey}</code>
          </div>
        )}
      </section>

      {/* LIST */}
      <section className="api-keys-panel">
        <h2>Keys</h2>
        {error && <div className="api-keys-error">{error}</div>}
        {loading ? (
          <div className="api-keys-empty">Loading…</div>
        ) : keys.length === 0 ? (
          <div className="api-keys-empty">No API keys yet.</div>
        ) : (
          <div className="api-keys-list">
            {keys.map((key) => (
              <article key={key.id} className="api-keys-row">
                <div className="api-keys-row-head">
                  <strong>{key.name}</strong>
                  <span className={`api-keys-tag ${key.key_type}`}>
                    {key.key_type}
                  </span>
                  {key.revoked_at && (
                    <span className="api-keys-tag revoked">revoked</span>
                  )}
                </div>
                <code className="api-keys-preview">{key.key_preview}</code>
                <div className="api-keys-scope-tags">
                  {key.scopes.length === 0 ? (
                    <span className="api-keys-muted">no scopes</span>
                  ) : (
                    key.scopes.map((scope) => (
                      <span key={scope} className="api-keys-scope-tag">
                        {scope}
                      </span>
                    ))
                  )}
                </div>
                <div className="api-keys-meta">
                  <span>{key.rate_limit_per_min}/min</span>
                  <span>
                    {key.expires_at
                      ? `expires ${fmtDateTime(key.expires_at)}`
                      : "no expiry"}
                  </span>
                  <span>
                    {key.last_used_at
                      ? `last used ${fmtDateTime(key.last_used_at)}`
                      : "never used"}
                  </span>
                </div>
                <div className="api-keys-actions">
                  <button type="button" onClick={() => openAudit(key.id)}>
                    Audit log
                  </button>
                  {!key.revoked_at && (
                    <button
                      type="button"
                      className="api-keys-revoke"
                      onClick={() => revoke(key.id)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* AUDIT */}
      {auditFor != null && (
        <section className="api-keys-panel">
          <div className="api-keys-audit-head">
            <h2>Audit log — key #{auditFor}</h2>
            <button type="button" onClick={() => setAuditFor(null)}>
              Close
            </button>
          </div>
          {auditLoading ? (
            <div className="api-keys-empty">Loading…</div>
          ) : auditRows.length === 0 ? (
            <div className="api-keys-empty">No requests recorded yet.</div>
          ) : (
            <div className="api-keys-audit-scroll">
              <table className="api-keys-audit">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Status</th>
                    <th>Outcome</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {auditRows.map((row) => (
                    <tr key={row.id}>
                      <td>{fmtDateTime(row.created_at)}</td>
                      <td>{row.method}</td>
                      <td>{row.path}</td>
                      <td>{row.status_code}</td>
                      <td>{row.outcome}</td>
                      <td>{row.ip ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
