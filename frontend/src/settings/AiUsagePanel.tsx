// Token-usage details for whoever holds `ai:manage`: totals plus a breakdown.
// An organization's owner gets its own members and models; the platform owner
// gets the whole site by scope, the platform team member by member, and models.
// Tokens only — cost and budget are intentionally omitted. The numbers come from
// live per-turn metering in `ai_usage_events`. Shared by the AI provider page
// and the standalone usage page so the two never drift.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { getAiUsage, type AiUsage } from "../api/aiProvider";

const num = (n: number) => n.toLocaleString();

type Row = { name: string; tokens: number };

function TokenTable({
  title,
  column,
  rows,
  empty,
}: {
  title: string;
  column: string;
  rows: Row[];
  empty: string;
}) {
  return (
    <section className="ai-card">
      <h2>{title}</h2>
      <table className="ai-table">
        <thead>
          <tr>
            <th>{column}</th>
            <th>Tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td>{num(r.tokens)}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={2}>{empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

type Member = {
  name: string;
  username?: string;
  tokens: number;
  requests: number;
};

// The team, one row each: who they are and what they used. Everyone on the
// team is listed, so a member at zero is visible too.
function MemberTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: Member[];
  empty: string;
}) {
  return (
    <section className="ai-card">
      <h2>{title}</h2>
      <table className="ai-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Requests</th>
            <th>Tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r) => {
              const username = r.username || r.name;
              return (
                <tr key={username}>
                  <td>
                    {username}
                    {r.name && r.name !== username && (
                      <span className="ai-member-name"> · {r.name}</span>
                    )}
                  </td>
                  <td>{num(r.requests)}</td>
                  <td>{num(r.tokens)}</td>
                </tr>
              );
            })
          ) : (
            <tr>
              <td colSpan={3}>{empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

// True when the response carries the platform owner's site-wide breakdown.
const isPlatformUsage = (usage: AiUsage) =>
  (usage.by_scope?.length ?? 0) > 0 ||
  (usage.platform_members?.length ?? 0) > 0;

export default function AiUsagePanel({
  showProvider = false,
}: {
  // The standalone page labels the provider; the AI provider page already
  // shows it above the panel.
  showProvider?: boolean;
}) {
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
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (loading) return <p>Loading…</p>;
  if (error) return <p className="ai-error">{error}</p>;
  if (!usage) return null;

  const totalTokens = usage.totals.input_tokens + usage.totals.output_tokens;
  const kpis: { label: string; value: number }[] = [
    { label: "Total tokens", value: totalTokens },
    { label: "Input tokens", value: usage.totals.input_tokens },
    { label: "Output tokens", value: usage.totals.output_tokens },
    { label: "Requests", value: usage.totals.requests },
  ];

  const modelCard = (
    <TokenTable
      title="By model"
      column="Model"
      rows={usage.by_model.map((m) => ({ name: m.model, tokens: m.tokens }))}
      empty="No AI usage yet."
    />
  );

  let breakdown: ReactNode;
  if (isPlatformUsage(usage)) {
    breakdown = (
      <>
        <div className="ai-table-row">
          <TokenTable
            title="Complete website usage — by scope"
            column="Scope"
            rows={(usage.by_scope ?? []).map((s) => ({
              name: s.label,
              tokens: s.tokens,
            }))}
            empty="No AI usage yet."
          />
          <MemberTable
            title="Platform team members"
            rows={usage.platform_members ?? []}
            empty="No platform team members yet."
          />
        </div>
        <div className="ai-table-row">{modelCard}</div>
      </>
    );
  } else {
    breakdown = (
      <div className="ai-table-row">
        <MemberTable
          title="By team member"
          rows={usage.by_member}
          empty="No team members yet."
        />
        {modelCard}
      </div>
    );
  }

  return (
    <>
      <div className="ai-usage-banner">
        {usage.sample && <span className="ai-sample-badge">Sample data</span>}
        <span>
          {showProvider && (
            <>
              Provider: <strong>{usage.provider}</strong>
              {usage.model ? ` · ${usage.model}` : ""} ·{" "}
            </>
          )}
          {usage.period}
        </span>
      </div>

      <div className="ai-kpi-grid">
        {kpis.map((k) => (
          <div className="ai-kpi" key={k.label}>
            <span className="ai-kpi-value">{num(k.value)}</span>
            <span className="ai-kpi-label">{k.label}</span>
          </div>
        ))}
      </div>

      {breakdown}
    </>
  );
}
