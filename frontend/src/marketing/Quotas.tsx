import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { ApiTier, QuotaStatus, getQuota, listTiers } from "../api/tiers";
import DocsShell from "../docs/DocsShell";
import "./quotas.css";

// Marketing copy + human-friendly labels per plan code. Lives alongside the
// page rather than in the API so the spec stays purely about numbers and
// product/marketing can iterate on tone without a backend deploy.
const COPY: Record<string, { headline: string; tagline: string; cta: string; highlight?: boolean }> = {
  basic_user: {
    headline: "Free",
    tagline: "Personal projects, evaluation, and tinkering.",
    cta: "Already included",
  },
  advance_user: {
    headline: "Advance",
    tagline: "Hobby apps and weekend automations.",
    cta: "Upgrade",
    highlight: true,
  },
  organization: {
    headline: "Organization",
    tagline: "Whole-team integrations and shared bots.",
    cta: "Upgrade",
  },
  enterprise: {
    headline: "Enterprise",
    tagline: "High-throughput or unlimited integrations.",
    cta: "Contact sales",
  },
};

function fmtPrice(cents: number, interval: string): string {
  if (cents === 0) return "$0";
  return `$${(cents / 100).toFixed(0)} / ${interval}`;
}

function fmtRate(rpm: number): string {
  if (rpm >= 1000) return `${(rpm / 1000).toFixed(rpm % 1000 === 0 ? 0 : 1)}k / min`;
  return `${rpm} / min`;
}

function fmtQuota(quota: number): string {
  if (quota < 0) return "Unlimited";
  if (quota >= 1_000_000) return `${(quota / 1_000_000).toFixed(quota % 1_000_000 === 0 ? 0 : 1)}M / mo`;
  if (quota >= 1_000) return `${(quota / 1_000).toFixed(quota % 1_000 === 0 ? 0 : 1)}k / mo`;
  return `${quota} / mo`;
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export default function Quotas() {
  const { user } = useAuth();
  const [tiers, setTiers] = useState<ApiTier[]>([]);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setError("");
    try {
      const list = await listTiers();
      setTiers(list);
      // Authenticated users get to see *their* current tier marked
      // distinctly + their usage strip; visitors only see the comparison.
      if (user) {
        try {
          setQuota(await getQuota());
        } catch {
          /* non-fatal — surface comparison without usage */
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tiers");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    const h = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(h);
  }, [reload]);

  return (
    <DocsShell title="Plans, quotas & rate limits">
    <div className="quotas-page">
      <header className="quotas-hero">
        <div className="quotas-hero-inner">
          <h1>API rate-limit tiers</h1>
          <p>
            Every plan ships with a documented requests/minute cap and a
            monthly request budget. Pick the smallest tier that comfortably
            covers your expected traffic — upgrades take effect on the next
            request after checkout.
          </p>
        </div>
      </header>

      {error && <div className="quotas-banner">{error}</div>}

      {quota && (
        <section className="quotas-usage" aria-label="Your current usage">
          <div>
            <strong>Your current tier:</strong> {quota.plan_name}
            <small>Resets {fmtDate(quota.cycle_resets_at)}</small>
          </div>
          <div className="quotas-usage-bars">
            <UsageBar
              label="Rate limit"
              value={null}
              limit={quota.rate_limit_per_min}
              formatLimit={fmtRate}
            />
            <UsageBar
              label="Monthly requests"
              value={quota.monthly_used}
              limit={quota.monthly_quota}
              formatLimit={fmtQuota}
              formatValue={(v) => v.toLocaleString()}
            />
          </div>
        </section>
      )}

      {loading ? (
        <div className="quotas-loader">Loading tiers…</div>
      ) : (
        <section className="quotas-grid">
          {tiers.map((tier) => {
            const copy = COPY[tier.code] ?? {
              headline: tier.name,
              tagline: "",
              cta: "Choose",
            };
            const isCurrent = quota?.plan_code === tier.code;
            return (
              <article
                key={tier.code}
                className={`quotas-card ${copy.highlight ? "highlight" : ""} ${isCurrent ? "current" : ""}`}
              >
                <header>
                  <span className="quotas-card-label">{copy.headline}</span>
                  <h2>{tier.name}</h2>
                  <p>{copy.tagline}</p>
                  <div className="quotas-card-price">
                    {fmtPrice(tier.amount_cents, tier.billing_interval)}
                  </div>
                </header>
                <dl className="quotas-card-specs">
                  <div>
                    <dt>Rate limit</dt>
                    <dd>{fmtRate(tier.rate_limit_per_min)}</dd>
                  </div>
                  <div>
                    <dt>Monthly requests</dt>
                    <dd>{fmtQuota(tier.monthly_quota)}</dd>
                  </div>
                  <div>
                    <dt>Audience</dt>
                    <dd>{tier.audience === "organization" ? "Org plan" : "Personal"}</dd>
                  </div>
                  <div>
                    <dt>Overage behaviour</dt>
                    <dd>HTTP 429 — retry after monthly cycle reset</dd>
                  </div>
                </dl>
                <footer>
                  {isCurrent ? (
                    <button type="button" disabled>Current plan</button>
                  ) : tier.code === "enterprise" ? (
                    <Link to="/enterprise" className="quotas-cta">{copy.cta} →</Link>
                  ) : (
                    <Link
                      to={`/pricing?plan=${tier.code}`}
                      className={`quotas-cta ${copy.highlight ? "primary" : ""}`}
                    >
                      {copy.cta} →
                    </Link>
                  )}
                </footer>
              </article>
            );
          })}
        </section>
      )}

      <section className="quotas-fineprint">
        <h2>How limits are enforced</h2>
        <ul>
          <li>
            The <strong>rate limit</strong> is per API key, rolling 60-second
            window. Each request is counted in Redis; a request that crosses
            the limit returns <code>429</code> immediately.
          </li>
          <li>
            The <strong>monthly request budget</strong> is aggregated across
            every API key you own. Issuing multiple keys does not multiply
            your budget — that prevents accidental usage spikes from a
            misconfigured CI job exhausting an unaware customer's allowance.
          </li>
          <li>
            A key created with <code>rate_limit_per_min</code> stricter than
            the plan cap stays at the stricter value. The plan cap is a
            ceiling, not a floor.
          </li>
          <li>
            The cycle is the <strong>calendar month</strong> in UTC.
            Counters reset at <code>00:00 UTC</code> on the first of every
            month, separate from your Stripe billing-cycle anniversary.
          </li>
          <li>
            If Redis is briefly unavailable, requests pass through (fail
            open). We surface dropped enforcement in the audit log so
            customers can see when this happened.
          </li>
        </ul>
      </section>
    </div>
    </DocsShell>
  );
}

function UsageBar({
  label,
  value,
  limit,
  formatLimit,
  formatValue,
}: {
  label: string;
  value: number | null;
  limit: number;
  formatLimit: (n: number) => string;
  formatValue?: (n: number) => string;
}) {
  const pct =
    limit < 0 || value == null || limit === 0 ? 0 : Math.min(100, (value / limit) * 100);
  return (
    <div className="quotas-usage-bar">
      <div className="quotas-usage-bar-head">
        <span>{label}</span>
        <span>
          {value == null
            ? formatLimit(limit)
            : `${formatValue ? formatValue(value) : value} / ${formatLimit(limit)}`}
        </span>
      </div>
      {value != null && limit >= 0 && (
        <div className="quotas-usage-bar-track">
          <div
            className={`quotas-usage-bar-fill ${pct > 80 ? "warn" : ""}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
