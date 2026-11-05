import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { API_SCOPES } from "../api/apiKeys";
import {
  createDeveloperApp,
  listDeveloperApps,
  revokeDeveloperApp,
  rotateDeveloperAppSecret,
  type DeveloperApp,
} from "../api/developerApps";
import { fmtDateTime } from "../utils/datetime";
import "../apikeys/apiKeys.css";

// Developer-app registration. Reuses the api-keys page styling (api-keys-*
// classes) so the two credential-management surfaces look identical.
export default function DeveloperAppsPage() {
  const { user } = useAuth();
  const canManage = hasPermission(user, "api_keys:manage");

  const [apps, setApps] = useState<DeveloperApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create form.
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [homepage, setHomepage] = useState("");
  const [redirects, setRedirects] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  // A freshly issued secret (create or rotate), shown exactly once. Keyed by app
  // id so the reveal sits next to the right app after a rotate.
  const [revealed, setRevealed] = useState<{
    id: number;
    secret: string;
  } | null>(null);

  useEffect(() => {
    if (!canManage) return;
    let alive = true;
    listDeveloperApps()
      .then((items) => {
        if (alive) setApps(items);
      })
      .catch((err) => {
        if (alive)
          setError(err instanceof Error ? err.message : "Failed to load apps");
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
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  const parseRedirects = (raw: string) =>
    raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError("");
    setRevealed(null);
    setCreating(true);
    try {
      const created = await createDeveloperApp({
        name: name.trim(),
        description: description.trim() || null,
        homepage_url: homepage.trim() || null,
        redirect_uris: parseRedirects(redirects),
        scopes: [...scopes],
      });
      setApps((prev) => [created, ...prev]);
      setRevealed({ id: created.id, secret: created.client_secret });
      setName("");
      setDescription("");
      setHomepage("");
      setRedirects("");
      setScopes(new Set());
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to register app"
      );
    } finally {
      setCreating(false);
    }
  };

  const rotate = async (id: number) => {
    setError("");
    try {
      const res = await rotateDeveloperAppSecret(id);
      setRevealed({ id, secret: res.client_secret });
      setApps((prev) =>
        prev.map((a) =>
          a.id === id
            ? { ...a, client_secret_preview: res.client_secret_preview }
            : a
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rotate secret");
    }
  };

  const revoke = async (id: number) => {
    setError("");
    try {
      await revokeDeveloperApp(id);
      setApps((prev) =>
        prev.map((a) =>
          a.id === id ? { ...a, revoked_at: new Date().toISOString() } : a
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke app");
    }
  };

  if (!canManage) {
    return (
      <div className="api-keys-page">
        <h1>App registration</h1>
        <p className="api-keys-empty">
          You do not have permission to register apps.
        </p>
      </div>
    );
  }

  return (
    <div className="api-keys-page">
      <h1>App registration</h1>
      <p className="api-keys-intro">
        Register an integration to get a public <code>client_id</code> and a{" "}
        <code>client_secret</code>. Other teams use these to connect their app
        to yours. The <code>redirect_uris</code> and scopes are stored for the
        upcoming OAuth &ldquo;Connect&rdquo; flow.
      </p>

      {/* CREATE */}
      <section className="api-keys-panel">
        <h2>Register app</h2>
        <form className="api-keys-form" onSubmit={submit}>
          <label>
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme Sync"
              required
            />
          </label>

          <label>
            <span>Description (optional)</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this integration does"
            />
          </label>

          <label>
            <span>Homepage URL (optional)</span>
            <input
              value={homepage}
              onChange={(e) => setHomepage(e.target.value)}
              placeholder="https://acme.example.com"
            />
          </label>

          <label>
            <span>Redirect URIs (one per line — for OAuth)</span>
            <textarea
              value={redirects}
              onChange={(e) => setRedirects(e.target.value)}
              placeholder={"https://acme.example.com/callback"}
              rows={3}
            />
          </label>

          <fieldset className="api-keys-scopes">
            <legend>Scopes the app may request</legend>
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

          <button type="submit" disabled={creating}>
            {creating ? "Registering…" : "Register app"}
          </button>
        </form>

        {createError && <div className="api-keys-error">{createError}</div>}
      </section>

      {/* LIST */}
      <section className="api-keys-panel">
        <h2>Apps</h2>
        {error && <div className="api-keys-error">{error}</div>}
        {loading ? (
          <div className="api-keys-empty">Loading…</div>
        ) : apps.length === 0 ? (
          <div className="api-keys-empty">No apps registered yet.</div>
        ) : (
          <div className="api-keys-list">
            {apps.map((app) => (
              <article key={app.id} className="api-keys-row">
                <div className="api-keys-row-head">
                  <strong>{app.name}</strong>
                  {app.revoked_at && (
                    <span className="api-keys-tag revoked">revoked</span>
                  )}
                </div>
                {app.description && (
                  <div className="api-keys-muted">{app.description}</div>
                )}
                <code className="api-keys-preview">
                  client_id: {app.client_id}
                </code>
                <code className="api-keys-preview">
                  secret: {app.client_secret_preview}
                </code>

                {revealed?.id === app.id && (
                  <div className="api-keys-reveal">
                    <strong>
                      Copy this secret now — it is shown only once:
                    </strong>
                    <code>{revealed.secret}</code>
                  </div>
                )}

                <div className="api-keys-scope-tags">
                  {app.scopes.length === 0 ? (
                    <span className="api-keys-muted">no scopes</span>
                  ) : (
                    app.scopes.map((scope) => (
                      <span key={scope} className="api-keys-scope-tag">
                        {scope}
                      </span>
                    ))
                  )}
                </div>

                {app.redirect_uris.length > 0 && (
                  <div className="api-keys-meta">
                    {app.redirect_uris.map((uri) => (
                      <span key={uri}>{uri}</span>
                    ))}
                  </div>
                )}

                <div className="api-keys-meta">
                  {app.homepage_url && <span>{app.homepage_url}</span>}
                  <span>created {fmtDateTime(app.created_at)}</span>
                </div>

                {!app.revoked_at && (
                  <div className="api-keys-actions">
                    <button type="button" onClick={() => rotate(app.id)}>
                      Rotate secret
                    </button>
                    <button
                      type="button"
                      className="api-keys-revoke"
                      onClick={() => revoke(app.id)}
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
