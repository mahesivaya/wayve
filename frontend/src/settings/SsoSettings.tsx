// Org-admin page for configuring per-organization OIDC SSO. Lives under
// /settings/sso. Requires the `sso:manage` permission (admin / owner /
// super_admin / security). Renders a single-form upsert backed by
// PUT /api/organizations/{id}/sso/config — the page is intentionally not
// a list because a single org has at most one SSO config.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  deleteSsoConfig,
  getSsoConfig,
  saveSsoConfig,
  testSsoConfig,
  type SsoConfig,
  type SsoConfigInput,
  type SsoTestResult,
} from "../api/sso";
import "./ssoSettings.css";

interface FormState {
  issuer_url: string;
  client_id: string;
  client_secret: string;
  allowed_domain: string;
  enforce_sso: boolean;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  issuer_url: "",
  client_id: "",
  client_secret: "",
  allowed_domain: "",
  enforce_sso: false,
  enabled: true,
};

export default function SsoSettings() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const canManage = hasPermission(user, "sso:manage");
  const orgId = user?.organization_id ?? null;

  const [existing, setExisting] = useState<SsoConfig | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testResult, setTestResult] = useState<SsoTestResult | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    if (!orgId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const cfg = await getSsoConfig(orgId);
      setExisting(cfg);
      if (cfg) {
        setForm({
          issuer_url: cfg.issuer_url,
          client_id: cfg.client_id,
          client_secret: "",
          allowed_domain: cfg.allowed_domain,
          enforce_sso: cfg.enforce_sso,
          enabled: cfg.enabled,
        });
      } else {
        setForm(EMPTY_FORM);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load SSO config"
      );
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (!canManage) {
    return (
      <div className="sso-settings">
        <h1>Single Sign-On</h1>
        <p className="sso-error">
          You need the <code>sso:manage</code> permission to view this page.
        </p>
        <button onClick={() => navigate("/home")}>Back to Home</button>
      </div>
    );
  }

  if (!orgId) {
    return (
      <div className="sso-settings">
        <h1>Single Sign-On</h1>
        <p className="sso-error">
          SSO is configured per organization. Your account is not attached to an
          organization yet.
        </p>
        <button onClick={() => navigate("/home")}>Back to Home</button>
      </div>
    );
  }

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    if (!orgId) return;
    setSaving(true);
    setError("");
    setStatus("");
    setTestResult(null);
    try {
      const payload: SsoConfigInput = {
        issuer_url: form.issuer_url.trim(),
        client_id: form.client_id.trim(),
        // Only send the secret if the admin typed a new one. PUT treats
        // an absent secret as "keep what's stored."
        client_secret: form.client_secret ? form.client_secret : undefined,
        allowed_domain: form.allowed_domain.trim(),
        enforce_sso: form.enforce_sso,
        enabled: form.enabled,
      };
      const saved = await saveSsoConfig(orgId, payload);
      setExisting(saved);
      setForm((prev) => ({ ...prev, client_secret: "" }));
      setStatus("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    if (!orgId || !existing) return;
    setTesting(true);
    setTestResult(null);
    setError("");
    try {
      const result = await testSsoConfig(orgId);
      setTestResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }

  async function onDelete() {
    if (!orgId || !existing) return;
    if (
      !window.confirm(
        "Remove SSO config? Org members using SSO will fall back to email/password."
      )
    ) {
      return;
    }
    setDeleting(true);
    setError("");
    try {
      await deleteSsoConfig(orgId);
      setExisting(null);
      setForm(EMPTY_FORM);
      setStatus("SSO removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="sso-settings">
      <header className="sso-settings-header">
        <h1>Single Sign-On (OIDC)</h1>
        <p>
          Bring your own identity provider (Okta, Azure AD, Google Workspace,
          Auth0, Keycloak — anything that speaks OpenID Connect). Members from
          your <strong>allowed domain</strong> can then sign in by entering
          their email on the login screen.
        </p>
      </header>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <form className="sso-form" onSubmit={onSave}>
          <fieldset disabled={saving}>
            <label>
              <span>Issuer URL</span>
              <input
                type="url"
                placeholder="https://accounts.google.com"
                value={form.issuer_url}
                onChange={(e) => update("issuer_url", e.target.value)}
                required
              />
              <small>
                The base URL of your IdP. Fluxze appends
                <code> /.well-known/openid-configuration</code> for discovery.
                E.g. <code>https://accounts.google.com</code> (Google Workspace),
                {" "}
                <code>https://acme.okta.com</code> (Okta), or
                {" "}
                <code>https://login.microsoftonline.com/&lt;tenant-id&gt;/v2.0</code>{" "}
                (Azure AD).
              </small>
            </label>

            <label>
              <span>Client ID</span>
              <input
                type="text"
                placeholder="1234567890-abc123def456.apps.googleusercontent.com"
                value={form.client_id}
                onChange={(e) => update("client_id", e.target.value)}
                required
              />
              <small>
                The OAuth client ID from your IdP. Google Workspace looks like
                {" "}
                <code>…apps.googleusercontent.com</code>.
              </small>
            </label>

            <label>
              <span>Client Secret</span>
              <input
                type="password"
                autoComplete="new-password"
                placeholder={
                  existing
                    ? "•••••••• (leave blank to keep)"
                    : "GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx"
                }
                value={form.client_secret}
                onChange={(e) => update("client_secret", e.target.value)}
                required={!existing}
              />
              <small>
                Encrypted at rest with AES-256-GCM. Only this server can decrypt
                it — never returned to the browser.
              </small>
            </label>

            <label>
              <span>Allowed email domain</span>
              <input
                type="text"
                placeholder="acme.com"
                value={form.allowed_domain}
                onChange={(e) => update("allowed_domain", e.target.value)}
                required
              />
              <small>
                Routes <code>alice@acme.com</code> to this IdP. Must be unique
                across the platform.
              </small>
            </label>

            <label className="sso-form-checkbox">
              <input
                type="checkbox"
                checked={form.enforce_sso}
                onChange={(e) => update("enforce_sso", e.target.checked)}
              />
              <span>
                <strong>Enforce SSO</strong> — members of this org can only sign
                in via the IdP (password login disabled).
              </span>
            </label>

            <label className="sso-form-checkbox">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => update("enabled", e.target.checked)}
              />
              <span>
                <strong>Enabled</strong> — uncheck to temporarily disable
                without losing the config.
              </span>
            </label>
          </fieldset>

          <div className="sso-form-actions">
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : existing ? "Save changes" : "Enable SSO"}
            </button>
            {existing && (
              <>
                <button
                  type="button"
                  onClick={onTest}
                  disabled={testing}
                  className="sso-secondary"
                >
                  {testing ? "Testing…" : "Test connection"}
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={deleting}
                  className="sso-danger"
                >
                  {deleting ? "Removing…" : "Remove SSO"}
                </button>
              </>
            )}
          </div>

          {existing && (
            <div className="sso-callback-info">
              <h3>Register this redirect URI at your IdP</h3>
              <code>{existing.redirect_uri}</code>
              <p>
                In your IdP (Okta / Azure AD / Google), create an OIDC web
                application with this exact redirect URI and copy the resulting
                client ID / secret here.
              </p>
            </div>
          )}

          {status && <p className="sso-status">{status}</p>}
          {error && <p className="sso-error">{error}</p>}

          {testResult && (
            <div className="sso-test-result">
              <h3>Connection OK</h3>
              <dl>
                <dt>Issuer</dt>
                <dd>{testResult.issuer}</dd>
                <dt>Authorize endpoint</dt>
                <dd>{testResult.authorization_endpoint}</dd>
                <dt>Token endpoint</dt>
                <dd>{testResult.token_endpoint}</dd>
                <dt>JWKS URI</dt>
                <dd>{testResult.jwks_uri}</dd>
              </dl>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
