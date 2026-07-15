// Owner-only AI usage and cost dashboard, gated by `ai:manage`. The figures are
// sample data for now (the response carries `sample: true`); real metering will
// arrive behind the same response shape.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  getAiUsage,
  getAnthropicCost,
  type AiUsage,
  type AnthropicCost,
} from "../api/aiProvider";
import "./aiProvider.css";

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const num = (n: number) => n.toLocaleString();

export default function AiUsageGovernance() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canManage = hasPermission(user, "ai:manage");

  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [anthropicCost, setAnthropicCost] = useState<AnthropicCost | null>(
    null
  );
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
    // Authoritative Anthropic spend is platform-owner-only, so a 403 or any
    // other failure hides the panel rather than blocking the page.
    try {
      setAnthropicCost(await getAnthropicCost());
    } catch {
      setAnthropicCost(null);
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
        <h1>AI Usage &amp; Cost</h1>
        <p className="ai-error">
          Only the organization <strong>owner</strong> can view AI usage.
        </p>
        <button onClick={() => navigate("/home")}>Back to Home</button>
      </div>
    );
  }

  const spentPct = usage
    ? Math.min(
        100,
        Math.round(
          (usage.budget.spent_cents / usage.budget.monthly_limit_cents) * 100
        )
      )
    : 0;
  const overThreshold = usage
    ? spentPct >= usage.budget.alert_threshold_pct
    : false;
  const maxDailyCost = usage
    ? Math.max(...usage.daily.map((d) => d.cost_cents), 1)
    : 1;

  return (
    <div className="ai-usage">
      <header className="ai-settings-header">
        <h1>AI Usage &amp; Cost Governance</h1>
        <p>
          Spend, volume, and per-member usage for your organization's AI
          provider.
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
              <span className="ai-kpi-value">{num(usage.totals.requests)}</span>
              <span className="ai-kpi-label">Requests</span>
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
            <div className="ai-kpi">
              <span className="ai-kpi-value">
                {usd(usage.totals.cost_cents)}
              </span>
              <span className="ai-kpi-label">Est. cost</span>
            </div>
            <div className="ai-kpi">
              <span className="ai-kpi-value">
                {num(usage.totals.active_users)}
              </span>
              <span className="ai-kpi-label">Active users</span>
            </div>
          </div>

          {anthropicCost?.configured && (
            <section className="ai-card">
              <h2>Authoritative spend — billed by Anthropic</h2>
              <p className="ai-budget-text">
                <strong>{usd(anthropicCost.total_cents ?? 0)}</strong> ·{" "}
                {anthropicCost.period}
                {anthropicCost.truncated ? " (partial)" : ""}
              </p>
              {anthropicCost.by_model && anthropicCost.by_model.length > 0 && (
                <table className="ai-table">
                  <thead>
                    <tr>
                      <th>Line item</th>
                      <th>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {anthropicCost.by_model.map((m) => (
                      <tr key={m.model}>
                        <td>{m.model}</td>
                        <td>{usd(m.cost_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="ai-budget-text ai-muted">
                Actual USD from Anthropic's Cost API — organization-wide, across
                all workspaces. The per-member figures below are local
                estimates; Anthropic cannot attribute spend to individual
                members.
              </p>
            </section>
          )}
          {anthropicCost && !anthropicCost.configured && (
            <section className="ai-card">
              <h2>Authoritative spend</h2>
              <p className="ai-budget-text ai-muted">
                Set an Anthropic Admin API key (<code>ANTHROPIC_ADMIN_KEY</code>
                ) on the server to show real billed spend from Anthropic's Cost
                API alongside the local estimate.
              </p>
            </section>
          )}

          <section className="ai-card">
            <h2>Budget</h2>
            <div className="ai-budget">
              <div className="ai-budget-bar">
                <div
                  className={`ai-budget-fill ${overThreshold ? "is-alert" : ""}`}
                  style={{ width: `${spentPct}%` }}
                />
              </div>
              <p className="ai-budget-text">
                {usd(usage.budget.spent_cents)} of{" "}
                {usd(usage.budget.monthly_limit_cents)} ({spentPct}%)
                {overThreshold && (
                  <span className="ai-budget-alert">
                    {" "}
                    · over {usage.budget.alert_threshold_pct}% alert threshold
                  </span>
                )}
              </p>
            </div>
          </section>

          <section className="ai-card">
            <h2>Cost — last 30 days</h2>
            <div className="ai-trend" aria-hidden="true">
              {usage.daily.map((d) => (
                <span
                  key={d.day}
                  className="ai-trend-bar"
                  style={{ height: `${(d.cost_cents / maxDailyCost) * 100}%` }}
                  title={`${d.day}: ${usd(d.cost_cents)} · ${d.requests} reqs`}
                />
              ))}
            </div>
          </section>

          <div className="ai-table-row">
            <section className="ai-card">
              <h2>By model</h2>
              <table className="ai-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Requests</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.by_model.map((m) => (
                    <tr key={m.model}>
                      <td>{m.model}</td>
                      <td>{num(m.requests)}</td>
                      <td>{usd(m.cost_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="ai-card">
              <h2>By member</h2>
              <table className="ai-table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Requests</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.by_member.map((m) => (
                    <tr key={m.name}>
                      <td>{m.name}</td>
                      <td>{num(m.requests)}</td>
                      <td>{usd(m.cost_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
