// Owner-only AI usage dashboard, gated by `ai:manage`. Shows token consumption
// only — total tokens, and tokens broken down by member and by model. Cost and
// budget are intentionally omitted; the numbers come from live per-turn metering
// in `ai_usage_events`.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { getAiUsage, type AiUsage } from "../api/aiProvider";
import "./aiProvider.css";

const num = (n: number) => n.toLocaleString();

export default function AiUsageGovernance() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canManage = hasPermission(user, "ai:manage");

  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setUsage(await getAiUsage());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load usage");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The no-permission branch renders its own view regardless of `loading`, so
    // there is no fetch to kick off.
    if (!canManage) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [canManage, load]);

  if (!canManage) {
    return (
      <div className="ai-usage">
        <h1>AI Usage</h1>
        <p className="ai-error">
          Only the organization <strong>owner</strong> can view AI usage.
        </p>
        <button onClick={() => navigate("/home")}>Back to Home</button>
      </div>
    );
  }

  const totalTokens = usage
    ? usage.totals.input_tokens + usage.totals.output_tokens
    : 0;

  // The platform owner gets the site-wide, per-tenant breakdown; org owners get
  // the classic by-member view. `by_scope`/`platform_members` are only populated
  // for the platform dashboard.
  const platformView =
    (usage?.by_scope?.length ?? 0) > 0 ||
    (usage?.platform_members?.length ?? 0) > 0;

  // Shared between both layouts so the "By model" table isn't duplicated.
  const modelCard = usage ? (
    <section className="ai-card">
      <h2>By model</h2>
      <table className="ai-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Tokens</th>
          </tr>
        </thead>
        <tbody>
          {usage.by_model.map((m) => (
            <tr key={m.model}>
              <td>{m.model}</td>
              <td>{num(m.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  ) : null;

  return (
    <div className="ai-usage">
      <header className="ai-settings-header">
        <h1>AI Token Usage</h1>
        <p>
          {platformView
            ? "Complete website usage across your whole platform — by scope, by team member, and by model."
            : "Token consumption for your AI provider, by member and by model."}
        </p>
        <button
          type="button"
          className="ai-link-btn"
          onClick={() => navigate("/settings/ai")}
        >
          ← Back to AI provider settings
        </button>
      </header>

      {loading ? (
        <p>Loading…</p>
      ) : error ? (
        <p className="ai-error">{error}</p>
      ) : usage ? (
        <>
          <div className="ai-usage-banner">
            {usage.sample && (
              <span className="ai-sample-badge">Sample data</span>
            )}
            <span>
              Provider: <strong>{usage.provider}</strong>
              {usage.model ? ` · ${usage.model}` : ""} · {usage.period}
            </span>
          </div>

          <div className="ai-kpi-grid">
            <div className="ai-kpi">
              <span className="ai-kpi-value">{num(totalTokens)}</span>
              <span className="ai-kpi-label">Total tokens</span>
            </div>
            <div className="ai-kpi">
              <span className="ai-kpi-value">
                {num(usage.totals.input_tokens)}
              </span>
              <span className="ai-kpi-label">Input tokens</span>
            </div>
            <div className="ai-kpi">
              <span className="ai-kpi-value">
                {num(usage.totals.output_tokens)}
              </span>
              <span className="ai-kpi-label">Output tokens</span>
            </div>
          </div>

          {platformView ? (
            <>
              <div className="ai-table-row">
                <section className="ai-card">
                  <h2>Complete website usage — by scope</h2>
                  <table className="ai-table">
                    <thead>
                      <tr>
                        <th>Scope</th>
                        <th>Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.by_scope!.map((s) => (
                        <tr key={s.label}>
                          <td>{s.label}</td>
                          <td>{num(s.tokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>

                <section className="ai-card">
                  <h2>Platform team members</h2>
                  <table className="ai-table">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.platform_members!.length ? (
                        usage.platform_members!.map((m) => (
                          <tr key={m.name}>
                            <td>{m.name}</td>
                            <td>{num(m.tokens)}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={2}>No platform-team usage yet.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </section>
              </div>
              <div className="ai-table-row">{modelCard}</div>
            </>
          ) : (
            <div className="ai-table-row">
              <section className="ai-card">
                <h2>By member</h2>
                <table className="ai-table">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.by_member.map((m) => (
                      <tr key={m.name}>
                        <td>{m.name}</td>
                        <td>{num(m.tokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              {modelCard}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
