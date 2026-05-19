import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import {
  cancelSubscription,
  getEntitlements,
  getOrganizationBilling,
  getStripeStatus,
  getSubscription,
  getUsage,
  listInvoices,
  listPlans,
  openBillingPortal,
  startCheckout,
  type Entitlements,
  type Invoice,
  type OrganizationBilling,
  type Plan,
  type StripeStatus,
  type SubscriptionResponse,
  type UsageResponse,
} from "../api/billing";
import "./billing.css";

const BYTES_IN_GB = 1024 * 1024 * 1024;
const UNLIMITED_STORAGE = -1;

const PLAN_COPY: Record<string, { price: string; features: string[]; action?: string }> = {
  basic_user: {
    price: "Free",
    features: ["Send/receive 1,000 emails per day", "Personal workspace", "Standard storage"],
  },
  advance_user: {
    price: "$7 / month",
    features: ["Encrypt and decrypt 1,000 items per day", "Personal paid workspace", "Monthly auto-renewal"],
  },
  organization: {
    price: "$10 / user / month",
    features: ["1-100 users", "Unlimited email send and receive", "Unlimited memory", "Organization billing"],
  },
  enterprise: {
    price: "Discussed",
    features: ["100+ users", "Unlimited emails", "Unlimited memory", "Custom onboarding"],
    action: "Discuss plan",
  },
};

const STRIPE_TEST_CARDS = [
  { label: "Visa credit", number: "4242 4242 4242 4242", result: "Successful payment" },
  { label: "Visa debit", number: "4000 0566 5566 5556", result: "Successful debit payment" },
  { label: "Requires auth", number: "4000 0025 0000 3155", result: "3D Secure challenge" },
  { label: "Declined", number: "4000 0000 0000 9995", result: "Decline test" },
];

function formatMoney(cents: number | null, currency: string | null): string {
  if (cents == null) return "—";
  return `${(cents / 100).toFixed(2)} ${(currency ?? "usd").toUpperCase()}`;
}

function formatBytes(bytes: number): string {
  if (bytes === UNLIMITED_STORAGE) return "Unlimited";
  if (bytes >= BYTES_IN_GB) return `${(bytes / BYTES_IN_GB).toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

export default function Billing() {
  const { user } = useAuth();
  const [params] = useSearchParams();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [sub, setSub] = useState<SubscriptionResponse | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [org, setOrg] = useState<OrganizationBilling | null>(null);
  const [stripeStatus, setStripeStatus] = useState<StripeStatus | null>(null);
  const [autopay, setAutopay] = useState(true);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const checkoutStatus = params.get("checkout");

  const reload = useCallback(async () => {
    setError("");
    try {
      const [planList, subscription, ent, invoiceList, usageData, stripe] =
        await Promise.all([
          listPlans(),
          getSubscription(),
          getEntitlements(),
          listInvoices(),
          getUsage(),
          getStripeStatus(),
        ]);
      setPlans(planList);
      setSub(subscription);
      setEntitlements(ent);
      setInvoices(invoiceList);
      setUsage(usageData);
      setStripeStatus(stripe);
      if (subscription.owner_type === "organization") {
        try {
          setOrg(await getOrganizationBilling());
        } catch {
          setOrg(null);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [reload]);

  const ownerType = sub?.owner_type ?? "personal";
  const currentPlanCode = sub?.subscription?.plan_code ?? null;

  const subscribe = async (code: string) => {
    setBusy(`plan:${code}`);
    setError("");
    try {
      const res = await startCheckout(code, autopay);
      window.location.assign(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout");
      setBusy("");
    }
  };

  const portal = async () => {
    setBusy("portal");
    setError("");
    try {
      const res = await openBillingPortal();
      window.location.assign(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open portal");
      setBusy("");
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    setError("");
    try {
      await cancelSubscription();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel");
    } finally {
      setBusy("");
    }
  };

  if (loading) {
    return <div className="billing-page">Loading billing…</div>;
  }

  const visiblePlans = plans;
  const activeSub = sub?.subscription ?? null;

  return (
    <div className="billing-page">
      <header className="billing-header">
        <div>
          <h1>Billing &amp; Plans</h1>
          <p>
            {ownerType === "organization"
              ? "Organization billing"
              : "Personal billing"}{" "}
            · {user?.email}
          </p>
        </div>
        <button
          className="billing-portal-btn"
          onClick={() => void portal()}
          disabled={busy === "portal"}
        >
          {busy === "portal" ? "Opening…" : "Manage payment methods"}
        </button>
      </header>

      {checkoutStatus === "success" && (
        <div className="billing-banner success">
          Checkout complete — your subscription will update once Stripe
          confirms.
        </div>
      )}
      {checkoutStatus === "cancel" && (
        <div className="billing-banner">Checkout was canceled.</div>
      )}
      {error && <div className="billing-banner error">{error}</div>}

      {/* ---- Subscription status ---- */}
      <section className="billing-card">
        <h2>Subscription</h2>
        {activeSub ? (
          <div className="billing-sub">
            <div className="billing-sub-row">
              <span>Plan</span>
              <strong>{activeSub.plan_name ?? activeSub.plan_code ?? "—"}</strong>
            </div>
            <div className="billing-sub-row">
              <span>Status</span>
              <strong className={`billing-status ${activeSub.status}`}>
                {activeSub.status}
              </strong>
            </div>
            <div className="billing-sub-row">
              <span>Price</span>
              <strong>
                {formatMoney(activeSub.amount_cents, activeSub.currency)}
                {activeSub.billing_interval
                  ? ` / ${activeSub.billing_interval}`
                  : ""}
              </strong>
            </div>
            <div className="billing-sub-row">
              <span>Renews</span>
              <strong>{formatDate(activeSub.current_period_end)}</strong>
            </div>
            {activeSub.cancel_at_period_end ? (
              <p className="billing-note">
                Cancels at the end of the current period.
              </p>
            ) : (
              <button
                className="billing-cancel-btn"
                onClick={() => void cancel()}
                disabled={busy === "cancel"}
              >
                {busy === "cancel" ? "Canceling…" : "Cancel subscription"}
              </button>
            )}
          </div>
        ) : (
          <p className="billing-empty">
            No active subscription — you are on the free tier.
          </p>
        )}
      </section>

      {/* ---- Plans / Checkout ---- */}
      <section className="billing-card">
        <h2>Plans</h2>
        <label className="billing-autopay">
          <span>
            AutoPay monthly renewals
            <small>Default selected: YES</small>
          </span>
          <select value={autopay ? "yes" : "no"} onChange={(event) => setAutopay(event.target.value === "yes")}>
            <option value="yes">YES</option>
            <option value="no">NO</option>
          </select>
        </label>
        <div className="billing-plan-grid">
          {visiblePlans.map((plan) => {
            const isCurrent = plan.code === currentPlanCode;
            const isFree = plan.amount_cents === 0;
            const copy = PLAN_COPY[plan.code];
            const isEnterprise = plan.code === "enterprise";
            const canBuy = plan.audience === ownerType && !isFree && !isEnterprise;
            return (
              <article
                key={plan.id}
                className={`billing-plan ${isCurrent ? "current" : ""}`}
              >
                <h3>{plan.name}</h3>
                <p className="billing-plan-price">
                  {copy?.price ?? (isFree
                    ? "Free"
                    : `${formatMoney(plan.amount_cents, plan.currency)} / ${plan.billing_interval}`)}
                </p>
                {plan.description && (
                  <p className="billing-plan-desc">{plan.description}</p>
                )}
                <ul className="billing-plan-features">
                  {(copy?.features ?? [
                    `${formatBytes(plan.storage_limit_bytes)} storage`,
                    `${plan.seat_limit} seat${plan.seat_limit === 1 ? "" : "s"}`,
                  ]).map((feature) => <li key={feature}>{feature}</li>)}
                </ul>
                {isCurrent ? (
                  <span className="billing-plan-tag">Current plan</span>
                ) : isFree ? (
                  <span className="billing-plan-tag muted">Included</span>
                ) : canBuy ? (
                  <button
                    onClick={() => void subscribe(plan.code)}
                    disabled={busy === `plan:${plan.code}`}
                  >
                    {busy === `plan:${plan.code}` ? "Redirecting…" : "Subscribe"}
                  </button>
                ) : (
                  <span className="billing-plan-tag muted">
                    {isEnterprise ? "Discussed" : `Requires ${plan.audience} account`}
                  </span>
                )}
              </article>
            );
          })}
          {visiblePlans.length === 0 && (
            <p className="billing-empty">No plans available.</p>
          )}
        </div>
      </section>

      <section className="billing-card">
        <h2>Payments</h2>
        <div className="billing-payment-status">
          <span>Stripe status</span>
          <strong className={stripeStatus?.configured ? "ready" : "not-ready"}>
            {stripeStatus?.configured ? "Connected" : "Not configured"}
          </strong>
          <span>Mode</span>
          <strong>{stripeStatus?.test_mode ? "Test mode" : "Live/not detected"}</strong>
          <span>Country</span>
          <strong>{stripeStatus?.country ?? "US"}</strong>
          <span>Publishable key</span>
          <code>{stripeStatus?.publishable_key ?? "pk_test_sample_configure_in_env"}</code>
        </div>
        <p className="billing-note">
          Use Stripe Checkout for real card entry. These are Stripe test card numbers for test mode only.
        </p>
        <div className="billing-card-list">
          {STRIPE_TEST_CARDS.map((card) => (
            <div className="billing-test-card" key={card.number}>
              <span>{card.label}</span>
              <strong>{card.number}</strong>
              <small>{card.result}</small>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Usage ---- */}
      <section className="billing-card">
        <h2>Usage</h2>
        {entitlements && (
          <p className="billing-note">
            Plan limit: {formatBytes(entitlements.storage_limit_bytes)} storage ·{" "}
            {entitlements.seat_limit} seats ·{" "}
            {entitlements.active ? "active" : "free tier"}
          </p>
        )}
        {usage && usage.metrics.length > 0 ? (
          <table className="billing-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Total</th>
                <th>Events</th>
              </tr>
            </thead>
            <tbody>
              {usage.metrics.map((metric) => (
                <tr key={metric.metric}>
                  <td>{metric.metric}</td>
                  <td>{metric.total}</td>
                  <td>{metric.events}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="billing-empty">No usage recorded yet.</p>
        )}
      </section>

      {/* ---- Invoices ---- */}
      <section className="billing-card">
        <h2>Invoices</h2>
        {invoices.length > 0 ? (
          <table className="billing-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>{formatDate(invoice.created_at)}</td>
                  <td>
                    {formatMoney(invoice.amount_paid_cents, invoice.currency)}
                  </td>
                  <td>{invoice.status}</td>
                  <td>
                    {invoice.hosted_invoice_url && (
                      <a
                        href={invoice.hosted_invoice_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="billing-empty">No invoices yet.</p>
        )}
      </section>

      {/* ---- Organization billing ---- */}
      {org && (
        <section className="billing-card">
          <h2>Organization billing — {org.organization.name}</h2>
          <div className="billing-sub-row">
            <span>Seats</span>
            <strong>
              {org.seats_used} / {org.seat_limit}
            </strong>
          </div>
          <div className="billing-sub-row">
            <span>Plan</span>
            <strong>
              {org.plan_code ?? "Free"} {org.plan_active ? "" : "(inactive)"}
            </strong>
          </div>
          {!org.can_manage && (
            <p className="billing-note">
              Only organization admins can change the organization plan.
            </p>
          )}
          <h3 className="billing-members-title">Members</h3>
          <table className="billing-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {org.members.map((member) => (
                <tr key={member.id}>
                  <td>{member.email}</td>
                  <td>{member.role ?? member.account_type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
