// Owner-only page to select/change the org's AI provider. Lives under
// /settings/ai. Requires the owner-only `ai:manage` permission and an
// enterprise-tier org (the backend enforces both). The owner picks a provider
// BLOCK, then fills that provider's fields (model + key, plus a base URL for the
// OpenAI-compatible block). Every member of the org then uses this provider; they
// can't change it. The key is encrypted at rest and never returned to the browser.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  deleteAiConfig,
  getAiConfig,
  putAiConfig,
  type AiConfig,
  type AiProviderId,
  type AiProviderOption,
} from "../api/aiProvider";
import "./aiProvider.css";

export default function AiSettings() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const canManage = hasPermission(user, "ai:manage");
  const isEnterprise = user?.current_plan?.tier === "enterprise";

  const [providers, setProviders] = useState<AiProviderOption[]>([]);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [selected, setSelected] = useState<AiProviderId | null>(null);
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [failClosed, setFailClosed] = useState(true);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await getAiConfig();
      setProviders(res.providers);
      setConfig(res.config);
      const initial = res.config.provider ?? res.providers[0]?.id ?? null;
      setSelected(initial);
      setModel(res.config.model ?? "");
      setBaseUrl(res.config.base_url ?? "");
      setFailClosed(res.config.fail_closed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load AI config");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The no-permission branch renders its own view below regardless of
    // `loading`, so we simply don't kick off the fetch.
    if (!canManage) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [canManage, load]);

  if (!canManage) {
    return (
      <div className="ai-settings">
        <h1>AI Provider</h1>
        <p className="ai-error">
          Only the organization <strong>owner</strong> can select the AI
          provider. (Requires the <code>ai:manage</code> permission.)
        </p>
        <button onClick={() => navigate("/home")}>Back to Home</button>
      </div>
    );
  }

  const selectedOption = providers.find((p) => p.id === selected) ?? null;
  const needsBaseUrl = selectedOption?.needs_base_url ?? false;
  // Whether the currently-selected provider already has a stored key (only true
  // when the selection matches what's saved).
  const hasStoredKey =
    !!config?.has_key && config.provider === selected;

  function pick(id: AiProviderId) {
    setSelected(id);
    setStatus("");
    setError("");
    // Reset per-provider fields to the saved value if re-selecting the stored
    // provider, else clear so defaults/placeholders show.
    if (config?.provider === id) {
      setModel(config.model ?? "");
      setBaseUrl(config.base_url ?? "");
    } else {
      setModel("");
      setBaseUrl("");
    }
    setApiKey("");
  }

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const saved = await putAiConfig({
        provider: selected,
        model: model.trim() || undefined,
        base_url: needsBaseUrl ? baseUrl.trim() || undefined : undefined,
        // Typed key → use it. Blank + same stored provider → omit (keep stored
        // key). Blank + a DIFFERENT provider → send "" so we never inherit the
        // previous provider's key (the backend then requires one, or — for
        // Gemini — falls back to the platform key).
        api_key: apiKey ? apiKey : hasStoredKey ? undefined : "",
        fail_closed: failClosed,
      });
      setConfig(saved);
      setApiKey("");
      setStatus("Saved. Your whole organization now uses this provider.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function onReset() {
    if (
      !window.confirm(
        "Reset to the platform default AI? Your organization will fall back to the built-in provider."
      )
    ) {
      return;
    }
    setResetting(true);
    setError("");
    setStatus("");
    try {
      await deleteAiConfig();
      await load();
      setStatus("Reset to the platform default.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset");
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="ai-settings">
      <header className="ai-settings-header">
        <h1>AI Provider</h1>
        <p>
          Choose the AI your organization's assistant runs on — your own provider
          account, key, and (optionally) endpoint. Every member uses what you
          select here; they can't change it. Keys are encrypted at rest and never
          shown again.
        </p>
        <button
          type="button"
          className="ai-link-btn"
          onClick={() => navigate("/settings/ai/usage")}
        >
          View usage &amp; cost governance →
        </button>
      </header>

      {!isEnterprise && (
        <p className="ai-warn">
          Selecting your own AI provider is an <strong>Enterprise</strong>{" "}
          feature. Saving will be rejected until your organization is on the
          Enterprise plan.
        </p>
      )}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <form className="ai-form" onSubmit={onSave}>
          <div className="ai-block-grid" role="radiogroup" aria-label="AI provider">
            {providers.map((p) => (
              <button
                type="button"
                key={p.id}
                role="radio"
                aria-checked={selected === p.id}
                className={`ai-block ${selected === p.id ? "is-selected" : ""}`}
                onClick={() => pick(p.id)}
              >
                <span className="ai-block-radio" aria-hidden="true" />
                <span className="ai-block-label">{p.label}</span>
                <span className="ai-block-vendor">{p.vendor}</span>
                {config?.provider === p.id && (
                  <span className="ai-block-active">In use</span>
                )}
              </button>
            ))}
          </div>

          {selectedOption && (
            <fieldset className="ai-fields" disabled={saving}>
              <label>
                <span>Model</span>
                <input
                  type="text"
                  placeholder={selectedOption.default_model}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
                <small>Leave blank to use {selectedOption.default_model}.</small>
              </label>

              {needsBaseUrl && (
                <label>
                  <span>Base URL</span>
                  <input
                    type="url"
                    placeholder="https://your-gateway.example.com/v1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    required
                  />
                  <small>
                    The API root for Azure OpenAI, an AWS Bedrock gateway, or an
                    internal proxy. Must be a public https endpoint.
                  </small>
                </label>
              )}

              <label>
                <span>API key</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    hasStoredKey ? "•••••••• (leave blank to keep)" : ""
                  }
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <small>
                  Your provider account's key. Encrypted at rest with
                  AES-256-GCM — only this server can decrypt it, and it's never
                  returned to the browser.
                </small>
              </label>

              <label className="ai-checkbox">
                <input
                  type="checkbox"
                  checked={failClosed}
                  onChange={(e) => setFailClosed(e.target.checked)}
                />
                <span>
                  <strong>Fail closed</strong> — if your provider is unreachable,
                  return an error instead of falling back to the platform default
                  (recommended for data control).
                </span>
              </label>
            </fieldset>
          )}

          <div className="ai-form-actions">
            <button type="submit" disabled={saving}>
              {saving ? "Validating…" : "Save provider"}
            </button>
            {config?.configured && (
              <button
                type="button"
                className="ai-secondary"
                onClick={onReset}
                disabled={resetting}
              >
                {resetting ? "Resetting…" : "Reset to default"}
              </button>
            )}
          </div>

          {status && <p className="ai-status">{status}</p>}
          {error && <p className="ai-error">{error}</p>}

          {config?.configured && config.last_validated_at && (
            <p className="ai-meta">
              Active: <strong>{config.provider}</strong>
              {config.model ? ` · ${config.model}` : ""} · last validated{" "}
              {new Date(config.last_validated_at).toLocaleString()}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
