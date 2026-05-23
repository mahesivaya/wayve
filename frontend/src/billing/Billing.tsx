import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import {
  cancelSubscription,
  createPaymentMethodSetupIntent,
  getEntitlements,
  getOrganizationBilling,
  getStripeStatus,
  getSubscription,
  getUsage,
  listInvoices,
  listPlans,
  setDefaultPaymentMethod,
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

const STRIPE_JS_URL = "https://js.stripe.com/v3/";

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

function loadStripeScript(): Promise<void> {
  if (window.Stripe) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${STRIPE_JS_URL}"]`
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Stripe.js failed to load")), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.src = STRIPE_JS_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Stripe.js failed to load"));
    document.head.appendChild(script);
  });
}

export default function Billing() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [sub, setSub] = useState<SubscriptionResponse | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [org, setOrg] = useState<OrganizationBilling | null>(null);
  const [stripeStatus, setStripeStatus] = useState<StripeStatus | null>(null);
  const [autopay, setAutopay] = useState(true);
  const [paymentFormOpen, setPaymentFormOpen] = useState(false);
  const [paymentFormReady, setPaymentFormReady] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState("");
  const [paymentSuccess, setPaymentSuccess] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const setupClientSecret = useRef("");
  const paymentElementRef = useRef<StripePaymentElement | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const stripeRef = useRef<StripeInstance | null>(null);

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
  // A personal account with no subscription row is implicitly on the free
  // Basic tier — surface that explicitly so the card renders as "Active"
  // instead of falling through to the generic "Included" placeholder.
  const effectiveCurrentCode =
    currentPlanCode ?? (ownerType === "personal" ? "basic_user" : null);
  const hasPaidPlan = (sub?.subscription?.amount_cents ?? 0) > 0;

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

  const clearPaymentElements = useCallback(() => {
    paymentElementRef.current?.destroy();
    paymentElementRef.current = null;
    elementsRef.current = null;
    stripeRef.current = null;
    setupClientSecret.current = "";
    setPaymentFormReady(false);
  }, []);

  const openPaymentMethodForm = async () => {
    if (paymentFormOpen) {
      setPaymentFormOpen(false);
      clearPaymentElements();
      return;
    }

    setBusy("payment-method");
    setError("");
    setPaymentMessage("");
    setPaymentSuccess("");
    setPaymentFormOpen(true);
    try {
      const publishableKey = stripeStatus?.publishable_key;
      if (!publishableKey || !publishableKey.startsWith("pk_")) {
        throw new Error("Stripe publishable key is not configured");
      }

      // SetupIntent's client_secret must be created once per Elements tree.
      // Cancel + reopen creates a fresh one (clearPaymentElements resets it).
      const [{ client_secret: clientSecret }] = await Promise.all([
        createPaymentMethodSetupIntent(),
        loadStripeScript(),
      ]);
      const stripe = window.Stripe?.(publishableKey) ?? null;
      if (!stripe) throw new Error("Stripe could not initialize");

      const isDark =
        document.documentElement.getAttribute("data-theme") === "dark";
      const elements = stripe.elements({
        clientSecret,
        appearance: { theme: isDark ? "night" : "stripe" },
      });
      const paymentElement = elements.create("payment", {
        layout: "tabs",
        fields: { billingDetails: "auto" },
      });
      paymentElement.on("change", (event) => {
        setPaymentMessage(event.error?.message ?? "");
      });
      paymentElement.on("ready", () => setPaymentFormReady(true));
      paymentElement.mount("#billing-payment-element");

      setupClientSecret.current = clientSecret;
      stripeRef.current = stripe;
      elementsRef.current = elements;
      paymentElementRef.current = paymentElement;
    } catch (err) {
      clearPaymentElements();
      setPaymentFormOpen(false);
      setError(err instanceof Error ? err.message : "Could not prepare payment method form");
    } finally {
      setBusy("");
    }
  };

  const savePaymentMethod = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy("save-payment-method");
    setPaymentMessage("");
    setPaymentSuccess("");

    try {
      const stripe = stripeRef.current;
      const elements = elementsRef.current;
      if (!stripe || !elements) {
        throw new Error("Payment form is not ready yet");
      }

      // redirect: "if_required" keeps us on the page when no 3DS challenge is
      // needed; on a 3DS card Stripe bounces to return_url and the effect
      // below reads ?setup_intent_client_secret to finish wiring the default.
      const result = await stripe.confirmSetup({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/billing?pm=saved`,
        },
        redirect: "if_required",
      });

      if (result.error) {
        throw new Error(result.error.message ?? "Could not save payment method");
      }

      const paymentMethod = result.setupIntent?.payment_method;
      const paymentMethodId =
        typeof paymentMethod === "string" ? paymentMethod : paymentMethod?.id;
      if (!paymentMethodId) {
        throw new Error("Stripe did not return a payment method");
      }

      await setDefaultPaymentMethod(paymentMethodId);
      setPaymentSuccess("Payment method saved.");
      setPaymentFormOpen(false);
      clearPaymentElements();
      await reload();
    } catch (err) {
      setPaymentMessage(err instanceof Error ? err.message : "Could not save payment method");
    } finally {
      setBusy("");
    }
  };

  useEffect(() => () => clearPaymentElements(), [clearPaymentElements]);

  // Post-return handler: after a 3DS challenge Stripe bounces back to
  // return_url with ?setup_intent_client_secret in the URL. Retrieve the
  // intent, attach the resulting payment method as default, then strip the
  // query so refreshes don't re-trigger.
  useEffect(() => {
    const intentSecret = params.get("setup_intent_client_secret");
    if (!intentSecret) return;
    const publishableKey = stripeStatus?.publishable_key;
    if (!publishableKey || !publishableKey.startsWith("pk_")) return;

    let cancelled = false;
    void (async () => {
      try {
        await loadStripeScript();
        if (cancelled) return;
        const stripe = window.Stripe?.(publishableKey) ?? null;
        if (!stripe) return;
        const result = await stripe.retrieveSetupIntent(intentSecret);
        if (cancelled) return;
        if (result.error) {
          setError(result.error.message ?? "Could not finish saving payment method");
          return;
        }
        const pm = result.setupIntent?.payment_method;
        const pmId = typeof pm === "string" ? pm : pm?.id;
        if (!pmId) return;
        await setDefaultPaymentMethod(pmId);
        if (cancelled) return;
        setPaymentSuccess("Payment method saved.");
        window.history.replaceState({}, "", "/billing");
        await reload();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not finish saving payment method");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [params, stripeStatus, reload]);

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
  const canViewStripeDetails =
    user?.account_type === "platform_admin" && user?.effective_role === "owner";

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
          onClick={() => void openPaymentMethodForm()}
          disabled={busy === "payment-method" || busy === "save-payment-method"}
        >
          {busy === "payment-method" ? "Preparing…" : "Manage payment methods"}
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
      {paymentSuccess && <div className="billing-banner success">{paymentSuccess}</div>}

      {paymentFormOpen && (
        <section className="billing-card">
          <h2>Payment method</h2>
          <form className="billing-payment-form" onSubmit={(event) => void savePaymentMethod(event)}>
            <div id="billing-payment-element" className="billing-stripe-field" />
            {paymentMessage && <p className="billing-payment-error">{paymentMessage}</p>}
            <div className="billing-payment-actions">
              <button
                type="submit"
                disabled={!paymentFormReady || busy === "save-payment-method"}
              >
                {busy === "save-payment-method" ? "Saving…" : "Save card"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setPaymentFormOpen(false);
                  clearPaymentElements();
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

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
            const isCurrent = plan.code === effectiveCurrentCode;
            const isFree = plan.amount_cents === 0;
            const copy = PLAN_COPY[plan.code];
            const isEnterprise = plan.code === "enterprise";
            const isForOwner = plan.audience === ownerType;
            const canBuy = isForOwner && !isCurrent && !isFree && !isEnterprise;
            const busyHere = busy === `plan:${plan.code}`;
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
                  <button type="button" disabled>Active</button>
                ) : isEnterprise ? (
                  <button type="button" onClick={() => navigate("/support")}>
                    Contact sales
                  </button>
                ) : canBuy ? (
                  <button
                    type="button"
                    onClick={() => void subscribe(plan.code)}
                    disabled={busyHere}
                  >
                    {busyHere ? "Redirecting…" : hasPaidPlan ? "Switch plan" : "Subscribe"}
                  </button>
                ) : (
                  <button type="button" disabled>
                    {isForOwner ? "Free tier" : `Requires ${plan.audience} account`}
                  </button>
                )}
              </article>
            );
          })}
          {visiblePlans.length === 0 && (
            <p className="billing-empty">No plans available.</p>
          )}
        </div>
      </section>

      {canViewStripeDetails && (
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
      )}

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
