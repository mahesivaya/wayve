import { FormEvent, useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import {
  CreateWebhookInput,
  CreatedWebhookEndpoint,
  WebhookDelivery,
  WebhookEndpoint,
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listEventCatalog,
  listWebhooks,
  testWebhook,
  updateWebhook,
} from "../api/webhooks";
import { fmtDateTime } from "../utils/datetime";
import "./webhooks.css";

function fmtDate(value: string | null): string {
  return fmtDateTime(value);
}

const EMPTY_DRAFT: CreateWebhookInput = {
  url: "",
  events: [],
  description: "",
  org_wide: false,
};

export default function Webhooks() {
  const { user } = useAuth();
  const isOrg = user?.scope === "organization" || user?.scope === "platform";

  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Create form
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<CreateWebhookInput>(EMPTY_DRAFT);
  const [busy, setBusy] = useState("");
  const [createdSecret, setCreatedSecret] = useState<CreatedWebhookEndpoint | null>(null);

  // Delivery viewer
  const [openId, setOpenId] = useState<number | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);

  const reload = useCallback(async () => {
    setError("");
    try {
      const [list, cat] = await Promise.all([
        listWebhooks(),
        listEventCatalog(),
      ]);
      setEndpoints(list);
      setCatalog(cat.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load webhooks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const h = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(h);
  }, [reload]);

  const toggleEvent = (event: string) => {
    setDraft((prev) => {
      const has = prev.events.includes(event);
      return {
        ...prev,
        events: has
          ? prev.events.filter((e) => e !== event)
          : [...prev.events, event],
      };
    });
  };

  const dismiss = () => {
    setError("");
    setSuccess("");
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    dismiss();
    setBusy("create");
    try {
      const created = await createWebhook(draft);
      setCreatedSecret(created);
      setShowForm(false);
      setDraft(EMPTY_DRAFT);
      setSuccess("Webhook created. Copy the signing secret now — it is shown only once.");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create webhook");
    } finally {
      setBusy("");
    }
  };

  const remove = async (endpoint: WebhookEndpoint) => {
    if (!window.confirm(`Delete webhook ${endpoint.url}? This cannot be undone.`)) {
      return;
    }
    dismiss();
    setBusy(`delete:${endpoint.id}`);
    try {
      await deleteWebhook(endpoint.id);
      setSuccess(`Removed ${endpoint.url}`);
      if (openId === endpoint.id) setOpenId(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setBusy("");
    }
  };

  const toggleEnabled = async (endpoint: WebhookEndpoint) => {
    dismiss();
    setBusy(`toggle:${endpoint.id}`);
    try {
      await updateWebhook(endpoint.id, { enabled: !endpoint.enabled });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setBusy("");
    }
  };

  const sendTest = async (endpoint: WebhookEndpoint) => {
    dismiss();
    setBusy(`test:${endpoint.id}`);
    try {
      await testWebhook(endpoint.id);
      setSuccess(`Test event queued for ${endpoint.url}. Open the Deliveries view to watch it land.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue test event");
    } finally {
      setBusy("");
    }
  };

  const openDeliveries = async (endpoint: WebhookEndpoint) => {
    dismiss();
    if (openId === endpoint.id) {
      setOpenId(null);
      return;
    }
    setOpenId(endpoint.id);
    setDeliveries([]);
    setDeliveriesLoading(true);
    try {
      setDeliveries(await listDeliveries(endpoint.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load deliveries");
    } finally {
      setDeliveriesLoading(false);
    }
  };

  if (loading) return <div className="webhooks-loader">Loading webhooks…</div>;

  return (
    <div className="webhooks-page">
      <header className="webhooks-header">
        <div>
          <h1>Webhooks</h1>
          <p>
            Receive signed JSON payloads when events happen in Wayve. Every
            request carries a <code>Wayve-Signature</code> header you can verify
            with the signing secret returned at creation.
          </p>
        </div>
        {!showForm && (
          <button type="button" className="wh-btn primary" onClick={() => setShowForm(true)}>
            + Add webhook
          </button>
        )}
      </header>

      {error && <div className="wh-banner error">{error}</div>}
      {success && <div className="wh-banner success">{success}</div>}

      {createdSecret && (
        <section className="wh-secret">
          <strong>Signing secret for {createdSecret.url}:</strong>
          <code>{createdSecret.secret}</code>
          <small>
            Store this somewhere safe — Wayve only shows it once. Verify
            incoming requests by recomputing HMAC-SHA256 of{" "}
            <code>{`${"<timestamp>.<body>"}`}</code> with this secret and
            comparing against the <code>v1=</code> token in{" "}
            <code>Wayve-Signature</code>.
          </small>
          <button
            type="button"
            className="wh-btn secondary"
            onClick={() => setCreatedSecret(null)}
          >
            I've copied it
          </button>
        </section>
      )}

      {showForm && (
        <form className="wh-form" onSubmit={(e) => void submit(e)}>
          <label>
            Endpoint URL
            <input
              required
              type="url"
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              placeholder="https://example.com/wayve/webhook"
            />
          </label>
          <label>
            Description (optional)
            <input
              value={draft.description ?? ""}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="e.g. CRM sync"
            />
          </label>
          {isOrg && (
            <label className="wh-checkbox">
              <input
                type="checkbox"
                checked={draft.org_wide ?? false}
                onChange={(e) =>
                  setDraft({ ...draft, org_wide: e.target.checked })
                }
              />
              <span>Receive events from every member of my organization</span>
            </label>
          )}
          <fieldset className="wh-events">
            <legend>Events ({draft.events.length})</legend>
            {catalog.map((event) => (
              <label key={event} className="wh-checkbox">
                <input
                  type="checkbox"
                  checked={draft.events.includes(event)}
                  onChange={() => toggleEvent(event)}
                />
                <code>{event}</code>
              </label>
            ))}
          </fieldset>
          <div className="wh-form-actions">
            <button
              type="button"
              className="wh-btn secondary"
              onClick={() => {
                setShowForm(false);
                setDraft(EMPTY_DRAFT);
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="wh-btn primary"
              disabled={busy === "create"}
            >
              {busy === "create" ? "Creating…" : "Create webhook"}
            </button>
          </div>
        </form>
      )}

      {endpoints.length === 0 ? (
        <div className="wh-empty">No webhooks yet. Add one to start receiving events.</div>
      ) : (
        endpoints.map((endpoint) => (
          <article key={endpoint.id} className="wh-row">
            <div className="wh-row-head">
              <div>
                <strong>{endpoint.url}</strong>
                {endpoint.description && (
                  <span className="wh-row-desc">{endpoint.description}</span>
                )}
              </div>
              <div className="wh-row-tags">
                {endpoint.org_wide && <span className="wh-pill info">org-wide</span>}
                <span className={`wh-pill ${endpoint.enabled ? "ok" : "error"}`}>
                  {endpoint.enabled ? "enabled" : "disabled"}
                </span>
                {endpoint.consecutive_failures > 0 && (
                  <span className="wh-pill warn">
                    {endpoint.consecutive_failures} consecutive failures
                  </span>
                )}
              </div>
            </div>
            <div className="wh-row-meta">
              <code>{endpoint.secret_preview}</code>
              <span>
                {endpoint.events.length} event{endpoint.events.length === 1 ? "" : "s"} ·{" "}
                {endpoint.events.slice(0, 3).join(", ")}
                {endpoint.events.length > 3 ? ` +${endpoint.events.length - 3} more` : ""}
              </span>
              <span>
                last success {fmtDate(endpoint.last_success_at)} · last failure{" "}
                {fmtDate(endpoint.last_failure_at)}
              </span>
            </div>
            <div className="wh-row-actions">
              <button
                type="button"
                className="wh-btn secondary"
                onClick={() => void sendTest(endpoint)}
                disabled={busy === `test:${endpoint.id}` || !endpoint.enabled}
              >
                Send test event
              </button>
              <button
                type="button"
                className="wh-btn secondary"
                onClick={() => void openDeliveries(endpoint)}
              >
                {openId === endpoint.id ? "Hide" : "Deliveries"}
              </button>
              <button
                type="button"
                className="wh-btn secondary"
                onClick={() => void toggleEnabled(endpoint)}
                disabled={busy === `toggle:${endpoint.id}`}
              >
                {endpoint.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                className="wh-btn danger"
                onClick={() => void remove(endpoint)}
                disabled={busy === `delete:${endpoint.id}`}
              >
                Delete
              </button>
            </div>

            {openId === endpoint.id && (
              <div className="wh-deliveries">
                {deliveriesLoading ? (
                  <div className="wh-empty">Loading deliveries…</div>
                ) : deliveries.length === 0 ? (
                  <div className="wh-empty">No delivery attempts yet.</div>
                ) : (
                  <table className="wh-table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Event</th>
                        <th>Status</th>
                        <th>HTTP</th>
                        <th>Attempts</th>
                        <th>Response</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.map((d) => (
                        <tr key={d.id}>
                          <td>{fmtDate(d.created_at)}</td>
                          <td>
                            <code>{d.event_type}</code>
                            <br />
                            <small style={{ color: "#6b7280" }}>{d.event_id}</small>
                          </td>
                          <td>
                            <span className={`wh-pill ${d.status === "delivered" ? "ok" : d.status === "pending" ? "info" : "error"}`}>
                              {d.status}
                            </span>
                          </td>
                          <td>{d.http_status ?? "—"}</td>
                          <td>{d.attempt_count}</td>
                          <td title={d.response_excerpt ?? ""}>
                            {d.response_excerpt
                              ? d.response_excerpt.slice(0, 80) + (d.response_excerpt.length > 80 ? "…" : "")
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </article>
        ))
      )}
    </div>
  );
}
