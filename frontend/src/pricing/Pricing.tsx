import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { listPlans, type Plan } from "../api/billing";
import { useAuth } from "../auth/useAuth";
import Layout from "../components/Layout";
import MarketingShell from "../marketing/MarketingShell";
import PublicPricingContent from "./PublicPricingContent";
import "./pricing.css";

const BYTES_IN_GB = 1024 * 1024 * 1024;
const BYTES_IN_TB = BYTES_IN_GB * 1024;

function formatBytes(bytes: number): string {
  // Non-positive byte counts mean "no quota set" (schema default) or a
  // legacy `-1` sentinel for unlimited. Render as "Unlimited" so a
  // pricing card never shows "-0 MB" or "0 MB storage", which read as
  // bugs to a visitor and aren't what the plan actually advertises.
  if (bytes <= 0) return "Unlimited";
  if (bytes >= BYTES_IN_TB) return `${(bytes / BYTES_IN_TB).toFixed(0)} TB`;
  if (bytes >= BYTES_IN_GB) return `${(bytes / BYTES_IN_GB).toFixed(0)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function priceLabel(plan: Plan): string {
  if (plan.amount_cents === 0) return "Free";
  return `${(plan.amount_cents / 100).toFixed(2)} ${plan.currency.toUpperCase()}`;
}

const INCLUDED_IN_EVERY_PLAN = [
  "Email with end-to-end encrypted chat",
  "Voice & video calling",
  "Drive file storage",
  "Notes, tasks, and scheduler",
  "AI Chat assistant",
];

const FAQ = [
  {
    q: "Can I change plans later?",
    a: "Yes — upgrade or downgrade any time from the Billing page. Changes are prorated by Stripe.",
  },
  {
    q: "What happens if I cancel?",
    a: "Your plan stays active until the end of the current billing period, then drops to the free tier.",
  },
  {
    q: "How does organization billing work?",
    a: "Organization plans are billed once for the whole workspace and cover every member. Only organization admins can change the plan.",
  },
];

function PlanCard({
  plan,
  onChoose,
  isCurrent,
}: {
  plan: Plan;
  onChoose: () => void;
  isCurrent: boolean;
}) {
  const isFree = plan.amount_cents === 0;
  const featureEntries = Object.entries(plan.features ?? {});
  return (
    <article
      className={`pricing-plan${isCurrent ? " is-current" : ""}`}
      aria-current={isCurrent ? "true" : undefined}
    >
      {isCurrent && <span className="pricing-plan-badge">Current plan</span>}
      <h3>{plan.name}</h3>
      <p className="pricing-plan-price">
        {priceLabel(plan)}
        {!isFree && (
          <span className="pricing-plan-interval"> / {plan.billing_interval}</span>
        )}
      </p>
      {plan.description && (
        <p className="pricing-plan-desc">{plan.description}</p>
      )}
      <ul className="pricing-plan-features">
        <li>{formatBytes(plan.storage_limit_bytes)} storage</li>
        <li>
          {plan.seat_limit} {plan.seat_limit === 1 ? "seat" : "seats"}
        </li>
        <li>Billed {plan.billing_interval}ly</li>
        {featureEntries.map(([key, value]) => (
          <li key={key}>
            {key}: {String(value)}
          </li>
        ))}
      </ul>
      <button
        className="pricing-plan-cta"
        onClick={onChoose}
        disabled={isCurrent}
      >
        {isCurrent ? "Current plan" : isFree ? "Get started" : "Choose plan"}
      </button>
    </article>
  );
}

// Public marketing tiers shown to logged-out visitors. The order matches the
// upsell story we want unauthenticated users to walk through:
//   1. Basic       – on-ramp / free
//   2. Advance     – first paid personal tier
//   3. More Advance – top personal tier
//   4. Small organization – team plan for 1-100 users
//   5. Enterprise  – 100+ users, contact-sales
// These are intentionally hardcoded (not fetched from /api/billing/plans)
// because the public page is design-owned marketing copy, distinct from the
// dynamic plan picker logged-in users see.
function PublicPricing() {
  return (
    <MarketingShell>
      <PublicPricingContent />
    </MarketingShell>
  );
}

// Logged-in pricing screen: pulls live plan rows from the backend and lets
// the user start a Stripe checkout from the Billing page. Authenticated
// users always see this — the public marketing tiers above are for
// logged-out visitors only.
function AuthenticatedPricing() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const upgradePlanCode = params.get("plan") ?? user?.current_plan?.code ?? "basic_user";
  const isPersonal = user?.account_type === "personal";
  const currentPlanCode = user?.current_plan?.code ?? null;
  const accountLabel =
    user?.account_type === "personal"
      ? "Personal account"
      : user?.account_type === "platform_admin"
      ? "Platform account"
      : "Organization account";
  // For org users with no active org subscription the backend returns the
  // synthetic "organization_free" row — render that as a clearer "no
  // subscription yet" status rather than echoing a plan name.
  const planLabel =
    currentPlanCode === "organization_free"
      ? "No subscription yet"
      : user?.current_plan?.name ?? upgradePlanCode;

  useEffect(() => {
    let alive = true;
    listPlans()
      .then((items) => {
        if (alive) setPlans(items);
      })
      .catch((err) => {
        if (alive) {
          setError(err instanceof Error ? err.message : "Failed to load plans");
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const personalPlans = useMemo(
    () => plans.filter((plan) => plan.audience === "personal"),
    [plans]
  );
  const organizationPlans = useMemo(
    () => plans.filter((plan) => plan.audience === "organization"),
    [plans]
  );

  return (
    <div className="pricing-page">
      <header className="pricing-header">
        <h1>Plans &amp; Pricing</h1>
        <p>
          One workspace for mail, chat, calls, files, notes, and AI — pick the
          plan that fits. Manage or switch any time from Billing.
        </p>
        <p className="pricing-account-context">
          {accountLabel} · {user?.email} · Current plan: {planLabel}
        </p>
        <button
          className="pricing-billing-link"
          onClick={() => navigate("/billing")}
        >
          Go to Billing
        </button>
      </header>

      {error && <div className="pricing-error">{error}</div>}
      {loading ? (
        <div className="pricing-empty">Loading plans…</div>
      ) : (
        <>
          <section className="pricing-section">
            <h2>Personal</h2>
            <p className="pricing-section-sub">For individual accounts.</p>
            <div className="pricing-grid">
              {personalPlans.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  isCurrent={plan.code === currentPlanCode}
                  onChoose={() => navigate("/billing")}
                />
              ))}
              {personalPlans.length === 0 && (
                <p className="pricing-empty">No personal plans available.</p>
              )}
            </div>
          </section>

          {!isPersonal && (
            <section className="pricing-section">
              <h2>Organization</h2>
              <p className="pricing-section-sub">
                One subscription that covers every member of the organization.
              </p>
              <div className="pricing-grid">
                {organizationPlans.map((plan) => (
                  <PlanCard
                    key={plan.id}
                    plan={plan}
                    isCurrent={plan.code === currentPlanCode}
                    onChoose={() => navigate("/billing")}
                  />
                ))}
                {organizationPlans.length === 0 && (
                  <p className="pricing-empty">
                    No organization plans available.
                  </p>
                )}
              </div>
            </section>
          )}

          {(() => {
            // Personal users can't act on org/enterprise plans, so the
            // comparison table is filtered to personal rows for them.
            const visiblePlans = isPersonal
              ? plans.filter((plan) => plan.audience === "personal")
              : plans;
            if (visiblePlans.length === 0) return null;
            return (
              <section className="pricing-section">
                <h2>Compare all plans</h2>
                <table className="pricing-table">
                  <thead>
                    <tr>
                      <th>Plan</th>
                      <th>For</th>
                      <th>Price</th>
                      <th>Storage</th>
                      <th>Seats</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePlans.map((plan) => (
                      <tr key={plan.id}>
                        <td>{plan.name}</td>
                        <td className="pricing-cap">{plan.audience}</td>
                        <td>
                          {priceLabel(plan)}
                          {plan.amount_cents > 0
                            ? ` / ${plan.billing_interval}`
                            : ""}
                        </td>
                        <td>{formatBytes(plan.storage_limit_bytes)}</td>
                        <td>{plan.seat_limit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })()}
        </>
      )}

      <section className="pricing-section">
        <h2>Every plan includes</h2>
        <ul className="pricing-included">
          {INCLUDED_IN_EVERY_PLAN.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="pricing-section">
        <h2>Questions</h2>
        <div className="pricing-faq">
          {FAQ.map((item) => (
            <div key={item.q} className="pricing-faq-item">
              <strong>{item.q}</strong>
              <p>{item.a}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// Public dispatch. Splitting into two top-level components (instead of an
// early-return inside one) keeps each component's hook order stable —
// `AuthenticatedPricing` runs `useEffect`/`useState`/`useMemo` only when
// it's actually mounted, and the unauthenticated path skips the API
// fetch entirely. The auth view is wrapped in `<Layout>` so signed-in
// users see the standard header + sidebar (this route lives outside the
// ProtectedRoute branch so the unauth path stays public).
export default function Pricing() {
  const { user } = useAuth();
  if (!user) return <PublicPricing />;
  return (
    <Layout>
      <AuthenticatedPricing />
    </Layout>
  );
}
