import { FormEvent, useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  createScimToken,
  listScimTokens,
  revokeScimToken,
  ScimToken,
  ScimTokenCreated,
} from "../api/scim";
import { fmtDateTime } from "../utils/datetime";
import "./scimTokens.css";

function fmtDate(value: string | null): string {
  return fmtDateTime(value);
}

export default function ScimTokens() {
  const { user } = useAuth();
  // SCIM bearer tokens move user data — gate the management surface on
  // `webhooks:manage` (matches the backend's permission requirement and
  // mirrors the SIEM-token gate on the AuditSecurity page).
  const canManage = hasPermission(user, "webhooks:manage");

  const [tokens, setTokens] = useState<ScimToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ScimTokenCreated | null>(null);

  const orgId = user?.organization_id ?? null;

  const reload = useCallback(async () => {
    if (!canManage) return;
    setError("");
    try {
      setTokens(await listScimTokens());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load SCIM tokens");
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    const h = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(h);
  }, [reload]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (orgId == null) {
      setError("SCIM tokens are scoped to an organization. Sign in as an organization admin.");
      return;
    }
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      const result = await createScimToken({ name: name.trim(), organization_id: orgId });
      setCreated(result);
      setSuccess("Token created. Copy it now — the raw value is shown only once.");
      setName("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create token");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: ScimToken) => {
    if (!window.confirm(`Revoke ${token.name}? Your IdP will start receiving 401s on next sync.`)) {
      return;
    }
    setError("");
    setSuccess("");
    try {
      await revokeScimToken(token.id);
      setSuccess(`Revoked ${token.name}`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke token");
    }
  };

  if (!user) return <Navigate to="/login" replace />;
  if (!canManage) {
    return (
      <div className="scim-tokens-page">
        <p className="scim-empty">
          You do not have permission to manage SCIM tokens. Ask an organization
          owner or admin.
        </p>
      </div>
    );
  }

  return (
    <div className="scim-tokens-page">
      <header className="scim-tokens-header">
        <div>
          <h1>SCIM 2.0 provisioning</h1>
          <p>
            Mint a bearer token here, then paste it into your IdP (Okta / Entra /
            Google Workspace / OneLogin). They'll create, update, and deprovision
            users automatically through{" "}
            <code>https://fluxze.com/scim/v2</code>.
          </p>
        </div>
      </header>

      {error && <div className="scim-banner error">{error}</div>}
      {success && <div className="scim-banner success">{success}</div>}

      {created && (
        <section className="scim-reveal">
          <strong>SCIM bearer token for {created.name}:</strong>
          <code>{created.token}</code>
          <small>
            Configure your IdP with this token + base URL{" "}
            <code>{created.scim_endpoint}</code>. The token is shown only once —
            close the dashboard without copying and you'll have to mint a fresh
            one.
          </small>
          <button type="button" onClick={() => setCreated(null)}>
            I've copied it
          </button>
        </section>
      )}

      <section className="scim-create">
        <form onSubmit={(e) => void submit(e)}>
          <label>
            Token name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Okta production"
            />
          </label>
          <button type="submit" disabled={busy || orgId == null}>
            {busy ? "Minting…" : "+ Create SCIM token"}
          </button>
        </form>
        {orgId == null && (
          <p className="scim-muted">
            Your account isn't bound to an organization yet. SCIM provisioning
            requires an organization-scoped account.
          </p>
        )}
      </section>

      <section className="scim-list">
        <h2>Active tokens</h2>
        {loading ? (
          <div className="scim-empty">Loading…</div>
        ) : tokens.length === 0 ? (
          <div className="scim-empty">No tokens yet. Mint one above.</div>
        ) : (
          <table className="scim-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Organization</th>
                <th>Preview</th>
                <th>Last used</th>
                <th>Created</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.organization_name ?? `#${t.organization_id}`}</td>
                  <td>
                    <code>{t.token_preview}</code>
                  </td>
                  <td>{fmtDate(t.last_used_at)}</td>
                  <td>{fmtDate(t.created_at)}</td>
                  <td>
                    {t.revoked_at ? (
                      <span className="scim-pill error">revoked</span>
                    ) : (
                      <span className="scim-pill ok">active</span>
                    )}
                  </td>
                  <td>
                    {!t.revoked_at && (
                      <button
                        type="button"
                        className="scim-btn danger"
                        onClick={() => void revoke(t)}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="scim-fineprint">
        <h2>Connecting your IdP</h2>
        <ul>
          <li>
            <strong>Base URL:</strong>{" "}
            <code>https://fluxze.com/scim/v2</code>
          </li>
          <li>
            <strong>Authentication:</strong>{" "}
            <code>Authorization: Bearer wv_scim_…</code>
          </li>
          <li>
            <strong>Supported operations:</strong> GET, POST, PUT, DELETE on{" "}
            <code>/Users</code>. PATCH is not implemented in v1.
          </li>
          <li>
            <strong>Supported filters:</strong> <code>userName eq "x"</code> and{" "}
            <code>externalId eq "x"</code>. Complex filters return 400.
          </li>
          <li>
            <strong>Discovery:</strong>{" "}
            <code>/scim/v2/ServiceProviderConfig</code>, <code>/Schemas</code>,{" "}
            <code>/ResourceTypes</code> are public (no token needed).
          </li>
        </ul>
      </section>
    </div>
  );
}
